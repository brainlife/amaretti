#!/usr/bin/node
'use strict';

var fs = require('fs');
var path = require('path');
var winston = require('winston');
var async = require('async');
var Client = require('ssh2').Client;

//mine
var config = require('../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../api/models/db');
var common = require('../api/common');

db.init(function(err) {
    if(err) throw err;
    test_services();
});

function test_services() {
    db.Service.find().exec(function(err, services) {
        if(err) return logger.error(err); //continue
        async.eachSeries(services, function(service, next_service) {
            /*
            // TODO...
            // I am not sure how to invoke test.sh and compare output against prestaged output files
            
            //register test task
            var task = new db.Task({
                user_id: config.test.service.user_id,
                instance_id: config.test.service.instance_id,
                service: service.name,
                status: "requested",
                status_msg: "Waiting to be picked up by sca-task",
                request_date: new Date()
            });
            task.progress_key = "_sca."+task.instance_id+"."+task._id;
            task.save(function(err, _task) {

                next_service();
            });
            */
        }, function() {
            logger.debug("done for this round.. waiting before running another round");
            setTimeout(test_services, 24*3600*1000); //run every day
        });
    });
}


