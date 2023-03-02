#!/usr/bin/env node

//runs every minute to post the current values

//node
const fs = require('fs');
const path = require('path');
const os = require('os');
const request = require('request');
const async = require('async');
const redis = require('redis');

const config = require('../config');
const db = require('../api/models');
const common = require('../api/common');
const influx = require('@influxdata/influxdb-client');

let graphite_prefix = process.argv[2];
if(!graphite_prefix) graphite_prefix = "dev";

//TODO - this has to match up between amaretti/bin/metrics and warehouse/api/controller querying for graphite data
function sensu_name(name) {
    name = name.toLowerCase();
    name = name.replace(/[_.@$#\/]/g, "-");
    name = name.replace(/[ ()]/g, "");
    return name;
}

db.init(err=>{
    if(err) throw err;
    common.connectRedis(err=>{
        run(err=>{
            if(err) throw err;
            common.redisClient.quit();
            db.disconnect();
        });
    });
}, false); //connectEvent = false

function run(cb) {
    //I can just load this directly from mongo.. but to be consistent 
    //with what user sees (via API) let's pull it from API..
    console.log("querying running jobs");
    request.get({
        url: "http://0.0.0.0:"+config.express.port+"/admin/services/running",
        json: true,
        headers: { authorization: "Bearer "+config.amaretti.jwt },
    }, function(err, res, list) {
        if(err) throw err;
        if(res.statusCode != "200") throw res.body;

        let services = {};
        let resources = {};
        let users = {};
        list.forEach(item=>{
            let service = item._id.service;
            let resource_id = item._id.resource_id;
            let user_id = item._id.user_id;
            let count = item.count;

            if(!services[service]) services[service] = 0;
            services[service] += count;

            if(!users[user_id]) users[user_id] = 0;
            users[user_id] += count;

            if(resource_id) {
                if(!resources[resource_id]) resources[resource_id] = 0;
                resources[resource_id] += count;
            }
        });

        let resource_details = {};
        let contact_details = {};
        let emits = {}; //key value to emit

        async.series([

            //pull resource detail
            next=>{
                db.Resource.find({_id: {$in: Object.keys(resources)}}).then(resources=>{
                    resources.forEach(resource=>{
                        resource_details[resource._id] = resource;
                    });
                    next();
                });
            },

            //pull contact details
            next=>{
                let uids = Object.keys(users).filter(i=>parseInt(i));
                if(uids.length == 0) return next(null, {});
                request.get({
                    url: config.api.auth+"/profile/list", json: true,
                    qs: {
                        where: JSON.stringify({
                            sub: {$in: uids},
                        }),
                        limit: 5000, //TODO unsustainable?
                    },
                    headers: { authorization: "Bearer "+config.wf.jwt },
                }, function(err, res, _contacts) {
                    if(err) return next(err);
                    _contacts.profiles.forEach(contact=>{
                        contact_details[contact.sub] = contact;
                    });
                    next();
                });
            },

            async next=>{
                //set 0 values for recently non-0 values
                const keys = await common.redisClient.hVals("amaretti.metric.*");
                keys.forEach(key=>{
                    //grab all the path after amaretti.metric.
                    let path = key.split(".").slice(2).join(".");
                    emits[path] = 0;
                });
            },

        ], err=>{
            //sensu keys that just popedup
            let newkeys = []; 

            const today = new Date();
            const time = Math.round(today.getTime()/1000);
            const writeApi = new influx.InfluxDB(config.influxdb.connection)
                .getWriteApi(config.influxdb.org, config.influxdb.bucket, 'ns')
            writeApi.useDefaultTags({location: config.influxdb.location})
            const point = new influx.Point("amaretti");
            point.timestamp(today);

            //for .. "dev.amaretti.service.brain-life-app-life 0 1549643698"
            for(let service in services) {
                const safe_name = sensu_name(service);
                const sensu_key = graphite_prefix+".service."+safe_name;
                common.redisClient.set('amaretti.metric.'+sensu_key, 1);
                common.redisClient.expire('amaretti.metric.'+sensu_key, 60*30); //expire in 30 minutes

                if(emits[sensu_key] === undefined) newkeys.push(sensu_key);
                emits[sensu_key] = services[service];
                point.intField("service."+safe_name, services[service]);
            }

            //for .. "test.resource.azure-slurm1shared 1 1549643698"
            //this is mainly for admin/grafana view - to quickly see which resource is which.. use resource-id for pragramatic
            for(let resource_id in resources) {
                let detail = resource_details[resource_id];
                if(!detail) {
                    console.error("no detail for", resource_id);
                } else {
                    const safe_name = sensu_name(detail.name);
                    const sensu_key = graphite_prefix+".resource."+safe_name;
                    common.redisClient.set('amaretti.metric.'+sensu_key, 1);
                    common.redisClient.expire('amaretti.metric.'+sensu_key, 60*30); //expire in 30 minutes
                    if(emits[sensu_key] === undefined) newkeys.push(sensu_key);
                    emits[sensu_key] = resources[resource_id];
                    point.intField("resource."+safe_name, resources[resource_id]);
                }
            }

            //for .. "test.resource.123456787 1 1549643698"
            for(let resource_id in resources) {
                let detail = resource_details[resource_id];
                if(!detail) {
                    console.error("no detail for", resource_id);
                } else {
                    const sensu_key = graphite_prefix+".resource-id."+resource_id
                    common.redisClient.set('amaretti.metric.'+sensu_key, 1);
                    common.redisClient.expire('amaretti.metric.'+sensu_key, 60*30); //expire in 30 minutes
                    if(emits[sensu_key] === undefined) newkeys.push(sensu_key);
                    emits[sensu_key] = resources[resource_id];
                    point.intField("resource-id."+resource_id, resources[resource_id]);
                }
            }

            //for "test.users.hayashis 1 1549643698"
            for(let user_id in users) {
                let user = contact_details[user_id];
                if(!user) {
                    console.error("no contact detail for", user_id);
                    continue
                } 
                const safe_name = user.username.replace(/\./g, '_');
                const sensu_key = graphite_prefix+".users."+safe_name;
                common.redisClient.set('amaretti.metric.'+sensu_key, 1);
                common.redisClient.expire('amaretti.metric.'+sensu_key, 60*30); //expire in 30 minutes
                if(emits[sensu_key] === undefined) newkeys.push(sensu_key);
                emits[sensu_key] = users[user_id];
                point.intField("user."+safe_name, users[user_id]);
            }

            //now emit
            newkeys.forEach(key=>{
                console.log(key+" 0 "+(time-1));
            });

            for(var key in emits) {
                console.log(key+" "+emits[key]+" "+time);
            }

            writeApi.writePoint(point);
            writeApi.close();


            cb();
        });
    });
}

