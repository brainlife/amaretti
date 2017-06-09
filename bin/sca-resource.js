#!/usr/bin/node
'use strict';

//node
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const async = require('async');
const request = require('request');

//mine
const config = require('../config');
const logger = new winston.Logger(config.logger.winston);
const db = require('../api/models');
const resource_lib = require('../api/resource');
const common = require('../api/common');

db.init(function(err) {
    if(err) throw err;
    start_check_resources();
});

function start_check_resources() {
    check_resources(function(err) {
        if(err) logger.error(err); //continue
        logger.debug("waiting before running another check_resource");
        setTimeout(start_check_resources, 3600*1000); //run every hour
    });
}

//go through all registered resources and check for connectivity & smoke test
function check_resources(cb) {
    db.Resource.find({active: true}, function(err, resources) {
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

            resource_lib.check(resource, function(err) {
                //I don't care if someone's resource status is failing or not
                //if(err) logger.info(err); 
                next_resource();
            });
        }, function(err) {
            if(err) logger.error(err); //continue
            else logger.debug("checked "+resources.length+" resources");

            var info = {
                ssh: common.report_ssh(),
                resources: resources.length,
                //message: "sca-wf-resource here!",
            }
            //report health status to sca-wf
            logger.info("reporting health");
            logger.info(info);
            var url = "http://"+(config.express.host||"localhost")+":"+config.express.port;
            request.post({url: url+"/health/resource", json: info}, function(err, res, body) {
                if(err) logger.error(err);
                cb();
            });
        });
    });
}


