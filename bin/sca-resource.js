#!/usr/bin/node
'use strict';

//node
const fs = require('fs');
const path = require('path');

//contrib
const winston = require('winston');
const async = require('async');

//mine
const config = require('../config');
const logger = new winston.Logger(config.logger.winston);
const db = require('../api/models/db');
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
                if(err) next_resource();
                else {
                    var detail = config.resources[resource.resource_id];
                    if(detail && detail.type == "ssh" && resource.status == "ok") {
                        //console.dir(detail);
                        clean_workdir(resource, function(err) {
                            if(err) logger.error(err); //continue
                            next_resource();
                        });
                    } else return next_resource();
                }
            });
        }, function(err) {
            if(err) logger.error(err); //continue
            else logger.debug("checked all resource");
            cb();
        });
    });
}

//find empty & old(5 days) instance directory and remove it
function clean_workdir(resource, cb) {
    common.get_ssh_connection(resource, function(err, conn) {
        if(err) return cb(err);
        var workdir = common.getworkdir("", resource);
        logger.debug("cleaning workdir:"+workdir+" for resource_id:"+resource._id);
        conn.exec("if [ -d \""+workdir+"\" ]; then find "+workdir+" -mtime +5 -type d -empty -maxdepth 1 -exec rmdir {} \\; fi", function(err, stream) {
            if(err) return cb(err);        
            stream.on('close', function(code, signal) {
                cb();
            })
            .on('data', function(data) {
                logger.debug(data.toString());
            }).stderr.on('data', function(data) {
                logger.debug(data.toString());
            });
        });
    }); 
}


