#!/usr/bin/node
'use strict';

//node
var fs = require('fs');
var path = require('path');

//contrib
var winston = require('winston');
var async = require('async');

//mine
var config = require('../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../api/models/db');
var resource_lib = require('../api/resource');

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
    db.Resource.find({}, function(err, resources) {
        async.eachSeries(resources, function(resource, next_resource) {
            //logger.debug("checking "+resource._id);
            resource_lib.check(resource, function(err) {
                //logger.debug("check called cb on "+resource._id);
                if(err) logger.error(err); //ignore the err
                next_resource();
            });
        }, function(err) {
            if(err) logger.error(err); //continue
            else logger.debug("checked all resource");
            cb();
        });
    });
}


