#!/usr/bin/node
'use strict';

//node
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const async = require('async');
const request = require('request');
const redis = require('redis');

//mine
const config = require('../config');
const logger = winston.createLogger(config.logger.winston);
const db = require('../api/models');
const resource_lib = require('../api/resource');
const common = require('../api/common');

var rcon = null;

db.init(function(err) {
    if(err) throw err;
    rcon = redis.createClient(config.redis.port, config.redis.server);
    rcon.on('error', err=>{throw err});
    rcon.on('ready', ()=>{
        logger.info("connected to redis");
        run();
    });
});

//go through all registered resources and check for connectivity & smoke test
function run() {
    db.Resource.find({
        active: true, 
        status: {$ne: "removed"},
        //_id: "59ea931df82bb308c0197c3d", //debug
    }, function(err, resources) {

        var counts = {};
        async.eachSeries(resources, function(resource, next_resource) {
            async.series([

                //check resource status
                next=>{
                    //TODO - should I add timeout?
                    console.log("checking "+resource._id+" "+resource.name);
                    resource_lib.check(resource, function(err) {
                        //I don't care if someone's resource status is failing or not
                        
                        //count status for health reporting.. (not sure what I will be using this for yet)
                        if(!counts[resource.status]) counts[resource.status] = 0;
                        counts[resource.status]++;
                        
                        //deactivate resource if it's never been ok-ed for a week
                        var weekold = new Date();
                        weekold.setDate(weekold.getDate() - 7);
                        if(!resource.lastok_date && resource.create_date < weekold && resource.status != "ok") {
                            logger.info("deactivating resource since it's never been active for long time");
                            resource.active = false;
                            return resource.save(next_resource);
                        }

                        //deactivate resource that's been down for a month or has never been active
                        var monthold = new Date();
                        monthold.setDate(monthold.getDate() - 7);
                        if(resource.lastok_date && resource.lastok_date < monthold && resource.status != "ok") {
                            logger.info("deactivating resource which has been non-ok for more than 30 days");
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
                    console.dir(config.metrics.api+"/render?target="+config.metrics.resource_prefix+"."+resource._id);
                    request.get({url: config.metrics.api+"/render", qs: {
                        target: config.metrics.resource_prefix+"."+resource._id,
                        from: "-3day",
                        format: "json",
                        noNullPoints: "true"
                    }, json: true, debug: true }, (err, _res, json)=>{
                        if(err) return next(err);
                        let data;
                        if(json.length == 0) data = []; //maybe never run?
                        else data = json[0].datapoints;

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

                //store past usage stats (just the total - not service info - which can be queried via api)
                next=>{
                    resource_lib.stat(resource, (err, stats)=>{
                        if(err) return next(err);
                        resource.stats.total = stats.total;
                        resource.stats.services = stats.services;
                        next();
                    });
                },

                //list _group_ids for each services
                /* //this query takes abnormally long time.. let's troubleshoot
                next=>{
                    db.Task.aggregate()
                    .match({ resource_id: resource._id })
                    .project({
                        _walltime: {$subtract: ["$finish_date", "$start_date"]},
                        _group_id: '$_group_id',
                    })
                    .group({_id: "$_group_id", count: {$sum: 1}, total_walltime: {$sum: "$_walltime"} })
                    .exec((err, projects)=>{
                        if(err) return next(err);
                        resource.stats.projects = projects;
                        next();
                    });
                },
                */
                
                //TODO.. query list of jobs currently running on this resource
                /*
                async next=>{
                    let tasks = await db.Task.find({
                        resource_id: resource._id,
                        status: {$in: ["requested", "running", "running_sync"]},
                    }).lean().select('_id user_id _group_id service service_branch status status_msg').exec()

                    console.dir(tasks);
                    //TODO..
                },
                */

                //lastly.. save everything
                next=>{
                    //console.log(JSON.stringify(resource.stats, null, 4));
                    resource.save(next);
                }
                 
            ], next_resource);
        }, err=>{
            if(err) logger.error(err); //continue
            else logger.debug("checked "+resources.length+" resources");
            report(resources, counts);

            logger.debug("waiting for 10mins before running another check_resource");
            setTimeout(run, 1000*60*10); //wait 10 minutes each check
        });
    });
}

function report(resources, counts) {
    var ssh = common.report_ssh();
    var report = {
        status: "ok",
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

    rcon.set("health.amaretti.resource."+(process.env.NODE_APP_INSTANCE||'0'), JSON.stringify(report));
}

