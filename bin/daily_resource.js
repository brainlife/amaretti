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

db.init(function(err) {
    if(err) throw err;
    db.Resource.find({
        active: true, 
        status: {$ne: "removed"},
        //_id: "59ea931df82bb308c0197c3d", //debug
    }, function(err, resources) {

        var counts = {};
        async.eachSeries(resources, function(resource, next_resource) {
            async.series([

                next=>{
                    console.log("aggregating info for ", resource.name);
                    next();
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

                /* too expensive... can I calculate this from resource.stats?
                //list _group_ids for each services
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
            console.log("all done");
            db.disconnect(()=>{
                process.exit(0);
            });
        });
    });
}, false); //don't connect to event(amqp)


