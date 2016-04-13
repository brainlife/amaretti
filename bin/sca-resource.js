#!/usr/bin/node
'use strict';

//node
var fs = require('fs');
var path = require('path');

//contrib
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
            check_resource(resource, next_resource);
        }, function(err) {
            if(err) logger.error(err); //continue
            else logger.debug("checked all resource");
            cb();
        });
    });
}

//run appropriate tests based on resource type
function check_resource(resource, cb) {
    var detail = config.resources[resource.resource_id];
    if(detail === undefined) {
        logger.error("unknown resource_id:"+resource.resource_id);
        return cb();
    }
    if(detail.type === undefined) {
        logger.error(resource.resource_id+" doesn't have type defined.. don't know how to check");
        return cb();
    }
    logger.debug(detail);
    switch(detail.type) {
    case "pbs": return check_ssh(resource, update_status);
    case "osg": return check_ssh(resource, update_status);
    case "xfer": return check_ssh(resource, update_status);
    case "docker": return check_ssh(resource, update_status);
    default: 
        logger.error("don't know how to check "+resource.type);
        cb(); //continue
    }

    function update_status(err, status, msg) {
        resource.status = status;
        resource.status_msg = msg;
        resource.status_update = new Date();
        resource.save(cb);
    }
}

function check_ssh(resource, cb) {
    var conn = new Client();
    conn.on('ready', function() {
        logger.debug("ssh connection ready");
        //run some command to make sure it's running
        conn.exec('whoami', function(err, stream) {
            if (err) throw err;
            var ret_username = "";
            stream.on('close', function(code, signal) {
                conn.end();
                if(ret_username.trim() == resource.config.username) {
                    cb(null, "ok", "ssh connection good and accepting command"); 
                } else {
                    cb(null, "ok", "ssh connection good but whoami reports:"+ret_username+" which is different from "+resource.config.username); 
                }
            }).on('data', function(data) {
                ret_username += data;
            }).stderr.on('data', function(data) {
                logger.error('whoami error: ');
            });
        })
        //conn.end();
        //cb(null, "unnknown", "??");
    });
    conn.on('end', function() {
        logger.debug("ssh connection ended");
    });
    conn.on('close', function() {
        logger.debug("ssh connection closed");
    });
    conn.on('error', function(err) {
        cb(null, "failed", err.toString());
    });
    common.decrypt_resource(resource);
    logger.debug("decrypted");
    var detail = config.resources[resource.resource_id];
    try {
        conn.connect({
            host: detail.hostname,
            username: resource.config.username,
            privateKey: resource.config.enc_ssh_private,
        });
    } catch (err) {
        cb(null, "failed", err.toString());
    }
}

