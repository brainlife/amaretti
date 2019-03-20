#!/usr/bin/env node

//runs every minute to post the current values

//node
const fs = require('fs');
const path = require('path');
const os = require('os');
const request = require('request');
const winston = require('winston');
const async = require('async');
const redis = require('redis');

const config = require('../config');

const graphite_prefix = process.argv[2];
if(!graphite_prefix) {
    console.error("usage: metrics.js <graphite_prefix>");
    process.exit(1);
}

//connect to redis - used to store previously non-0 data
const re = redis.createClient(config.redis.port, config.redis.server);

//TODO - this has to match up between amaretti/bin/metrics and warehouse/api/controller querying for graphite daa
function sensu_name(name) {
    name = name.toLowerCase();
    name = name.replace(/[_.@$#\/]/g, "-");
    name = name.replace(/[ ()]/g, "");
    return name;
}

//I can just load this directly from mongo.. but to be consistent 
//with what user sees (via API) let's pull it from API..
request.get({
    url: "http://localhost:"+config.express.port+"/admin/services/running",
    json: true,
    headers: { authorization: "Bearer "+config.amaretti.jwt },
}, function(err, res, list) {
    if(err) throw err;
    if(res.statusCode != "200") throw res.body;

    //console.log(JSON.stringify(list, null, 4));
    //convert list of service/resouce_id keys into various statistics
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

    let emits = {}; //key value to emit
    async.parallel({

        //pull resource detail
        resource_details: cb=>{
            request.get({
                url: "http://localhost:"+config.express.port+"/resource", json: true,
                qs: {
                    find: JSON.stringify({
                        _id: {$in: Object.keys(resources)},
                        user_id: null, //admin can do this to bypass user id filtering
                    }),
                },
                headers: { authorization: "Bearer "+config.wf.jwt },
            }, function(err, res, _resources) {
                let resource_details = {};
                _resources.resources.forEach(resource=>{
                    resource_details[resource._id] = resource;
                });
                cb(err, resource_details);
            });
        },

        //pull contact details
        contact_details: cb=>{
            if(Object.keys(users).length == 0) return cb(null, {});
            request.get({
                url: config.api.auth+"/profile", json: true,
                qs: {
                    where: JSON.stringify({
                        id: {$in: Object.keys(users)},
                    }),
                    limit: 5000, //TODO unsustainable?
                },
                headers: { authorization: "Bearer "+config.wf.jwt },
            }, function(err, res, _contacts) {
                if(err) return cb(err);
                let contact_details = {};
                _contacts.profiles.forEach(contact=>{
                    contact_details[contact.id] = contact;
                });
                cb(null, contact_details);
            });
        },

        recent: cb=>{
            //set 0 values for recently non-0 values
            re.keys("amaretti.metric.*", (err, recs)=>{
                if(err) return cb(err);
                recs.forEach(rec=>{
                    //grab all the path after amaretti.metric.
                    let path = rec.split(".").slice(2).join(".");
                    emits[path] = 0;
                });
                cb();
            });
        },

    }, (err, results)=>{
        //sensu keys that just popedup
        let newkeys = []; 

        //output gathered data in sensu format
        const time = Math.round(new Date().getTime()/1000);

        //for .. "dev.amaretti.service.brain-life-app-life 0 1549643698"
        for(let service in services) {
            let safe_name = sensu_name(service);
            let sensu_key = graphite_prefix+".service."+safe_name;
            re.set('amaretti.metric.'+sensu_key, 1);
            re.expire('amaretti.metric.'+sensu_key, 60*30); //expire in 30 minutes

            if(emits[sensu_key] === undefined) newkeys.push(sensu_key);
            emits[sensu_key] = services[service];
        }

        //for .. "test.resource.azure-slurm1shared 1 1549643698"
        //this is mainly for admin/grafana view - to quickly see which resource is which.. use resource-id for pragramatic
        for(let resource_id in resources) {
            let detail = results.resource_details[resource_id];
            if(!detail) {
                console.error("no detail for", resource_id);
            } else {
                let sensu_key = graphite_prefix+".resource."+sensu_name(detail.name);
                re.set('amaretti.metric.'+sensu_key, 1);
                re.expire('amaretti.metric.'+sensu_key, 60*30); //expire in 30 minutes
                if(emits[sensu_key] === undefined) newkeys.push(sensu_key);
                emits[sensu_key] = resources[resource_id];
            }
        }
      
        //for .. "test.resource.123456787 1 1549643698"
        for(let resource_id in resources) {
            let detail = results.resource_details[resource_id];
            if(!detail) {
                console.error("no detail for", resource_id);
            } else {
                let sensu_key = graphite_prefix+".resource-id."+resource_id
                re.set('amaretti.metric.'+sensu_key, 1);
                re.expire('amaretti.metric.'+sensu_key, 60*30); //expire in 30 minutes
                if(emits[sensu_key] === undefined) newkeys.push(sensu_key);
                emits[sensu_key] = resources[resource_id];
            }
        }

        //for "test.users.hayashis 1 1549643698"
        for(let user_id in users) {
            let user = results.contact_details[user_id];
            let sensu_key = graphite_prefix+".users."+user.username;
            re.set('amaretti.metric.'+sensu_key, 1);
            re.expire('amaretti.metric.'+sensu_key, 60*30); //expire in 30 minutes
            if(emits[sensu_key] === undefined) newkeys.push(sensu_key);
            emits[sensu_key] = users[user_id];
        }
    
        //now emit
        newkeys.forEach(key=>{
            console.log(key+" 0 "+(time-1));
        });
        for(var key in emits) {
            console.log(key+" "+emits[key]+" "+time);
        }

        re.end(true);
    });
});


