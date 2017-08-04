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

var redis_client = null;

db.init(function(err) {
    if(err) throw err;
    redis_client = redis.createClient(config.redis.port, config.redis.server);
    redis_client.on('error', err=>{throw err});
    redis_client.on('ready', ()=>{
        logger.info("connected to redis");
        start_check_resources();
        /*
        health_check();
        setInterval(health_check, 1000*60); //post health status every minutes
        */
    });
});

function start_check_resources() {
    check_resources(function(err) {
        if(err) logger.error(err); //continue
        logger.debug("waiting before running another check_resource");
        setTimeout(start_check_resources, 1000*60*30); //run every 30 minutes
    });
}

//go through all registered resources and check for connectivity & smoke test
function check_resources(cb) {
    db.Resource.find({active: true}, function(err, resources) {
        var counts = {};
        async.eachSeries(resources, function(resource, next_resource) {

            //deactivate resource if it's never been ok-ed for a weel
            var weekold = new Date();
            weekold.setDate(weekold.getDate() - 7);
            if(!resource.lastok_date && resource.create_date < weekold && resource.status != "ok") {
                logger.info("deactivating resource "+resource._id+ " since it's never been active for long time");
                resource.active = false;
                resource.save(next_resource);
                return;
            }

            if(!counts[resource.status]) counts[resource.status] = 0;
            counts[resource.status]++;

            resource_lib.check(resource, function(err) {
                //I don't care if someone's resource status is failing or not
                //if(err) logger.info(err); 
                next_resource();
            });
        }, function(err) {
            if(err) logger.error(err); //continue
            else logger.debug("checked "+resources.length+" resources");
            health_check(resources, counts);
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
    redis_client.set("health.workflow.resource."+(process.env.NODE_APP_INSTANCE||'0'), JSON.stringify(report));
}
