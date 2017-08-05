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
const logger = new winston.Logger(config.logger.winston);
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
        check_resources();
    });
});

//go through all registered resources and check for connectivity & smoke test
function check_resources() {
    db.Resource.find({active: true}, function(err, resources) {
        var counts = {};
        async.eachSeries(resources, function(resource, next_resource) {
            logger.debug("checking",resource._id, resource.name);

            //TODO - should I add timeout?
            resource_lib.check(resource, function(err) {
                //I don't care if someone's resource status is failing or not
                //if(err) logger.info(err); 
                
                //count status for health reporting.. (not sure what I will be using this for yet)
                if(!counts[resource.status]) counts[resource.status] = 0;
                counts[resource.status]++;
                
                //deactivate resource if it's never been ok-ed for a week
                var weekold = new Date();
                weekold.setDate(weekold.getDate() - 7);
                if(!resource.lastok_date && resource.create_date < weekold && resource.status != "ok") {
                    logger.info("deactivating resource since it's never been active for long time");
                    resource.active = false;
                    //resource.status_msg = "never been active since registered";
                    return resource.save(next_resource);
                }
                //deactivate resource that's been down for a month or has never been active
                var monthold = new Date();
                monthold.setDate(monthold.getDate() - 7);
                if(resource.lastok_date && resource.lastok_date < monthold && resource.status != "ok") {
                    logger.info("deactivating resource which has been non-ok for more than 30 days");
                    resource.active = false;
                    //resource.status_msg = "non-ok for more than 30 days";
                    return resource.save(next_resource);
                }

                return next_resource();
            });
        }, function(err) {
            if(err) logger.error(err); //continue
            else logger.debug("checked "+resources.length+" resources");
            health_check(resources, counts);

            logger.debug("waiting before running another check_resource");
            setTimeout(check_resources, 1000*60*30); //wait 30 minutes each check
        });
    });
}

function health_check(resources, counts) {
    var ssh = common.report_ssh();
    var report = {
        status: "ok",
        ssh,
        resources: resources.length,
        messages: [],
        counts,
        date: new Date(),
        maxage: 1000*60*30, //runs every 30 minutes
    }

    if(resources.length == 0) {
        report.status = "failed";
        report.messages.push("no resource checked.. not registered?");
    }
    rcon.set("health.workflow.resource."+(process.env.NODE_APP_INSTANCE||'0'), JSON.stringify(report));
}
