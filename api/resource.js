'use strict';

//contrib
var winston = require('winston');
var async = require('async');
var Client = require('ssh2').Client;

//mine
var config = require('../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('./models/db');
var common = require('./common');

exports.select = function(user_id, query, cb) {
    //select all resource available for the user and online
    db.Resource.find({
        user_id: user_id,
        status: 'ok', 
    })
    //.lean()
    .exec(function(err, resources) {
        if(err) return cb(err);
        if(resources.length == 0) logger.warn("user:"+user_id+" has no active resource");
        if(query.preferred_resource_id) logger.info("user preferred_resource_id:"+query.preferred_resource_id);

        //select the best resource based on the query
        var best = null;
        var best_score = null;
        resources.forEach(function(resource) {
            var score = score_resource(resource, query);
            if(score == 0) return;
            //logger.debug(resource._id+" type:"+resource.type+" score="+score);
            if(!best || score > best_score) {
                //normally pick the best score...
                best_score = score;
                best = resource;
            } else if(score == best_score && 
                query.preferred_resource_id && 
                query.preferred_resource_id == resource._id.toString()) {
                //but if score ties, give user preference into consideration
                logger.debug("using "+query.preferred_resource_id+" since score tied");
                best = resource; 
            }
        });

        //for debugging
        if(best) {
            logger.debug("best resource chosen:"+best._id);
            logger.debug(config.resources[best.resource_id]);
        } else {
            logger.debug("no resource matched query");
            logger.debug(query);
        } 
        cb(null, best, best_score);
    });
}

function score_resource(resource, query) {
    var resource_detail = config.resources[resource.resource_id];
    //logger.debug(resource_detail);
    //see if resource supports the service
    //TODO other things we could do..
    //1... handle query.other_service_ids and give higher score to resource that provides more of those services
    //2... benchmark performance from service test and give higher score on resource that performs better at real time
    //3... take resource utilization into account (pick least used docker host, for example)
    var info = resource_detail.services[query.service];
    if(info === undefined) return 0;
    return info.score;
}

//run appropriate tests based on resource type
exports.check = function(resource, cb) {
    var detail = config.resources[resource.resource_id];
    if(detail === undefined) return cb("unknown resource_id:"+resource.resource_id);
    if(detail.type === undefined) return cb(resource.resource_id+" doesn't have type defined.. don't know how to check");

    logger.debug(detail);
    switch(detail.type) {
    case "pbs":
    case "osg": 
    case "xfer": 
    case "docker": 
        return check_ssh(resource, update_status);
    default: 
        cb("don't know how to check "+resource.type);
    }

    function update_status(err, status, msg) {
        if(err) return cb(err);
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
    console.dir(resource);
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

