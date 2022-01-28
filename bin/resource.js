#!/usr/bin/env node
'use strict';

const fs = require('fs');
const async = require('async');
const request = require('request');
const redis = require('redis');

const config = require('../config');
const db = require('../api/models');
const resource_lib = require('../api/resource');
const common = require('../api/common');

const pkg = require('../package.json');

var rcon = null;

db.init(function(err) {
    if(err) throw err;
    run();
}, false); //don't connect to amqp

async function report(resources, counts, cb) {
    const ssh = common.report_ssh();
    const report = {
        status: "ok",
        version: pkg.version,
        ssh,
        resources: resources.length,
        messages: [],
        counts,
        date: new Date(),
        maxage: 1000*60*60,
    }

    if(resources.length == 0) {
        report.status = "failed";
        report.messages.push("no resource checked.. not registered?");
    }

    if(ssh.max_channels > 5) {
        report.status = "failed";
        report.messages.push("high ssh channels "+ssh.max_channels);
    }

    if(ssh.ssh_cons > 20) {
        report.status = "failed";
        report.messages.push("high ssh connections "+ssh.ssh_cons);
    }

    console.log("---reporting---");
    console.dir(report);
    rcon = redis.createClient(config.redis.port, config.redis.server);
    rcon.on('error', cb);
    rcon.on('ready', ()=>{
        console.log("connected to redis");
        rcon.set("health.amaretti.resource."+process.env.HOSTNAME, JSON.stringify(report));
        rcon.end(true);
        cb(); 
    });
}

//go through all registered resources and check for connectivity & smoke test
function run() {
    db.Resource.find({
        active: true, 
        status: {$ne: "removed"},
    }, function(err, resources) {

        var counts = {};
        async.eachSeries(resources, function(resource, next_resource) {
            async.series([

                //check resource status
                next=>{
                    //TODO - should I add timeout?
                    console.log("checking resource--------", resource._id, resource.name);
                    resource_lib.check(resource, function(err) {
                        //I don't care if someone's resource status is failing or not

                        //count status for health reporting.. (not sure what I will be using this for yet)
                        if(!counts[resource.status]) counts[resource.status] = 0;
                        counts[resource.status]++;

                        //deactivate resource if it's never been ok-ed for a week
                        var weekold = new Date();
                        weekold.setDate(weekold.getDate() - 7);
                        if(!resource.lastok_date && resource.create_date < weekold && resource.status != "ok") {
                            console.log("deactivating resource since it's never been active for long time");
                            resource.active = false;
                            return resource.save(next_resource);
                        }

                        //deactivate resource that's been down for a month or has never been active
                        var monthold = new Date();
                        monthold.setDate(monthold.getDate() - 7);
                        if(resource.lastok_date && resource.lastok_date < monthold && resource.status != "ok") {
                            console.log("deactivating resource which has been non-ok for more than 30 days");
                            resource.active = false;
                            return resource.save(next_resource);
                        }

                        return next();
                    });
                },

                //store recent usage history
                //https://graphite-api.readthedocs.io/en/latest/api.html#the-render-api-render
                //curl "http://10.0.0.10/render?target=dev.amaretti.resource-id.59ea931df82bb308c0197c3d&format=json&from=-1day&noNullPoints=true" | jq -r
                next=>{
                    //console.dir(config.metrics.api+"/render?target="+config.metrics.resource_prefix+"."+resource._id);
                    request.get({url: config.metrics.api+"/render", qs: {
                        target: config.metrics.resource_prefix+"."+resource._id,
                        from: "-3day",
                        format: "json",
                        noNullPoints: "true"
                    }, json: true, debug: true }, (err, _res, json)=>{
                        if(err) return next(err);
                        let data = [];
                        if(json.length) data = json[0].datapoints;

                        //aggregate graph into each hours
                        let start = new Date();
                        let max = parseInt(start.getTime()/1000);
                        start.setDate(start.getDate()-1);
                        let min = parseInt(start.getTime()/1000);

                        let recent_job_counts = [];
                        for(let d = min;d < max;d+=3600) {
                            let max_value = 0;
                            data.forEach(point=>{
                                //if(d[1] > d && d[1] < d+3600 && d[0] > max_value) max_value = d[1];
                                if(point[1] > d && point[1] < d+3600 && point[0] > max_value) max_value = point[0];
                            });
                            recent_job_counts.push([d, max_value]); 
                        }
                        resource.stats.recent_job_counts = recent_job_counts;
                        next();
                    });
                },

                next=>{
                    console.log("saving resource");
                    resource.save(next);
                }

            ], next_resource);
        }, err=>{
            if(err) console.error(err); //continue
            else console.debug("checked "+resources.length+" resources");
            report(resources, counts, err=>{
                db.disconnect()
                console.log("all done");
            });
        });
    });
}

