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
    case "pbs":
    case "osg": 
    case "xfer": 
    case "docker": 
        return check_ssh(resource, update_status);
    //case "hpss": 
    //    return check_hpss(resource, update_status);
    default: 
        logger.error("don't know how to check "+resource.type);
        cb(); //continue
    }

    function update_status(err, status, msg) {
        if(err) return cb(err); //failed to determine status
        logger.info("status:"+status+" msg:"+msg);
        resource.status = status;
        resource.status_msg = msg;
        resource.status_update = new Date();
        resource.save(cb);
    }
}

function check_hpss(resource, cb) {
    //find best resource to run hpss
}

function check_ssh(resource, cb) {
    var conn = new Client();
    conn.on('ready', function() {
        logger.debug("ssh connection ready");
        //run some command to make sure it's running
        conn.exec('whoami', function(err, stream) {
            if (err) return cb(nullerr);
            var ret_username = "";
            stream.on('close', function(code, signal) {
                if(ret_username.trim() == resource.config.username) {
                    check_sftp(resource, conn, function(err, status, msg) {
                        conn.end();
                        if(err) return cb(err);
                        cb(null, status, msg);
                    });
                } else {
                    conn.end();
                    //TODO does it really matter that whois reports a wrong user?
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

//make sure I can open sftp connection and access workdir
function check_sftp(resource, conn, cb) {
    var workdir = common.getworkdir(null, resource);
    //console.log("opening sftp connection");

    /*
    //make sure cb gets called once
    var cb_called = false;
    function cb_once(err, status, msg) {
        if(cb_called) {
            logger.error("check_sftp cb_once called more than once.. ignoring");
            logger.error([err, status, msg]);
            return;
        }
        cb_called = true;
        cb(err, status, msg);
    }
    */

    conn.sftp(function(err, sftp) {
        if(err) return cb(err);
        logger.debug("reading directory:"+workdir);
        var t = setTimeout(function() {
            t = null;
            cb(null, "failed", "workdir is inaccessible");
        }, 5000);
        sftp.readdir(workdir, function(err, list) {
            if(!t) return; //timeout already called
            if(err) return cb(err);
            clearTimeout(t);
            //console.dir(list);
            cb(null, "ok", "ssh connection good and workdir is accessible");
        });
    });
}

