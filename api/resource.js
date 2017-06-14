'use strict';

//contrib
var winston = require('winston');
var async = require('async');
var Client = require('ssh2').Client;

//mine
var config = require('../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('./models');
var common = require('./common');

//task needs to have populated deps
exports.select = function(user, task, cb) {
    //select all resource available for the user and active
    logger.debug("finding resource to run .select task_id:",task._id,"service:",task.service,"branch:",task.service_branch,"user:",user,"deps:");

    //pull resource_ids of deps
    var dep_resource_ids = [];
    if(task.deps) {
        //logger.debug(JSON.stringify(task.deps, null, 4));
        task.deps.forEach(dep=>{
            dep.resource_ids.forEach(id=>{
                id = id.toString();
                if(!~dep_resource_ids.indexOf(id)) dep_resource_ids.push(id);
            });
        });
        logger.debug("dep_resource_ids:", dep_resource_ids);
    }

    db.Resource.find({
        "$or": [
            {user_id: user.sub},
            {gids: {"$in": user.gids||[] }},
        ],
        status: 'ok', 
        active: true,
    })
    .exec(function(err, resources) {
        if(err) return cb(err);
        if(resources.length == 0) logger.warn("user:"+user.sub+" has no resource instance");
        if(task.preferred_resource_id) logger.info("user preferred_resource_id:"+task.preferred_resource_id);

        //select the best resource based on the task
        var best = null;
        var best_score = null;
        resources.forEach(function(resource) {
            logger.debug("resource:",resource.name, resource._id.toString())
            var score = score_resource(user, resource, task);
            if(score == 0) return;

            //+5 if resource is listed in dep
            if(~dep_resource_ids.indexOf(resource._id.toString())) {
                logger.debug("  resource listed in deps/resource_ids.. +5");
                score = score+5;
            }

            //+10 score if it's owned by user
            if(resource.user_id == user.sub) {
                logger.debug("  user owns this.. +10");
                score = score+10;
            }
            //+15 score if it's preferred by user (TODO need to make sure this still works)
            if(task.preferred_resource_id && task.preferred_resource_id == resource._id.toString()) {
                logger.debug("  user prefers this.. +15");
                score = score+15;
            }
            logger.debug("  score:",score);

            //pick the best score...
            if(!best || score > best_score) {
                best_score = score;
                best = resource;
            } 
        });

        //for debugging
        if(best) {
            logger.debug("best resource chosen:"+best._id+" name:"+best.name+" with score:"+best_score);
        } else {
            logger.debug("no resource matched to run this task :)");
        } 
        cb(null, best, best_score);
    });
}

function score_resource(user, resource, task) {
    //see if this resource supports requested service
    var resource_detail = config.resources[resource.resource_id];
    //TODO other things we could do..
    //1... handle task.other_service_ids and give higher score to resource that provides more of those services
    //2... benchmark performance from service test and give higher score on resource that performs better at real time
    //3... take resource utilization into account (pick least used docker host, for example)
    if(!resource_detail) {
        logger.error("  resource detail no longer exists for resource_id:"+resource.resource_id);
        return 0;
    }

    //see if the resource.config has score
    if( resource.config && 
        resource.config.services) {
        var score = null;
        resource.config.services.forEach(function(service) {
            if(service.name == task.service) score = service.score;
        });
        if(score) return score;
    }
    
    //pull resource_detail info
    if( resource_detail && 
        resource_detail.services &&
        resource_detail.services[task.service]) {
        return resource_detail.services[task.service].score;
    }
    logger.debug("  this resource doesn't support "+task.service);
    return 0;
}

//run appropriate tests based on resource type
exports.check = function(resource, cb) {
    var detail = config.resources[resource.resource_id];
    if(detail === undefined) return cb("unknown resource_id:"+resource.resource_id);
    if(detail.type === undefined) return cb(resource.resource_id+" doesn't have type defined.. don't know how to check");

    //logger.debug(detail);
    switch(detail.type) {
    case "ssh":
        check_ssh(resource, update_status);
        break;
    default: 
        //update_status(null, "ok", "Don't know how to check "+resource.type + " .. assuming it to be ok");
        check_hpss(resource, update_status);
    }

    function update_status(err, status, msg) {
        if(err) return cb(err);
        logger.info("resource_id: "+resource._id+" status:"+status+" msg:"+msg);
        resource.status = status;
        resource.status_msg = msg;
        resource.status_update = new Date();
        if(status == "ok") resource.lastok_date = new Date();
        resource.save(function(err) {
            cb(err, {status: status, message: msg});
        });
    }
}

function check_hpss(resource, cb) {
    //find best resource to run hpss
    common.ls_hpss(resource, "./", function(err, files) {
        if(err) return cb(null, "failed", err);
        cb(null, "ok", "hsi/ls returned "+files.length+" files on home directory");
    });
}

//TODO this is too similar to common.js:ssh_command... can we refactor?
function check_ssh(resource, cb) {
    var conn = new Client();
    var ready = false;
    var nexted = false;
    conn.on('ready', function() {
        ready = true;

        //make sure correct user id is returned from whoami
        conn.exec('whoami', function(err, stream) {
            if (err) {
                conn.end();
                nexted = true;
                return cb(err);
            }
            var ret_username = "";
            stream.on('close', function(code, signal) {
                nexted = true;
                if(ret_username.trim() == resource.config.username) {

                    check_sftp(resource, conn, function(err, status, msg) {
                        conn.end();
                        if(err) return cb(err);
                        cb(null, status, msg);
                    });
                } else {
                    conn.end();
                    //I need to fail if user is outputing something on the terminal (right now, it kills ssh2/sftp)
                    cb(null, "failed", "ssh connection good but whoami reports:"+ret_username+" which is different from "+resource.config.username+" Please make sure your .bashrc is not outputting any content for non-interactive session."); 
                }
            }).on('data', function(data) {
                ret_username += data;
            }).stderr.on('data', function(data) {
                //I get \n stuff occasionally
                logger.debug('whoami error: ');
            });
        })
    });
    conn.on('end', function() {
        logger.debug("ssh connection ended");
    });
    conn.on('close', function() {
        logger.debug("ssh connection closed");
        if(!ready && !nexted) cb(null, "failed", "Connection closed before becoming ready.. probably in maintenance mode?");
    });
    conn.on('error', function(err) {
        nexted = true;
        cb(null, "failed", err.toString());
    });

    //clone resource so that decrypted content won't leak out of here
    var decrypted_resource = JSON.parse(JSON.stringify(resource));
    common.decrypt_resource(decrypted_resource);
    logger.debug("check_ssh / decrypted");
    var detail = config.resources[resource.resource_id];
    try {
        conn.connect({
            host: resource.config.hostname || detail.hostname,
            username: resource.config.username,
            privateKey: decrypted_resource.config.enc_ssh_private,
            //no need to set keepaliveInterval(in millisecond) because checking resource should take less than a second
        });
    } catch (err) {
        cb(null, "failed", err.toString());
    }
}

//make sure I can open sftp connection and access workdir
function check_sftp(resource, conn, cb) {
    var workdir = common.getworkdir(null, resource);
    conn.sftp(function(err, sftp) {
        if(err) return cb(err);
        logger.debug("reading dir "+workdir);
        var to = setTimeout(()=>{
            logger.error("readdir timeout"); 
            cb(null, "failed", "readdir timeout - filesytem is offline?");
        }, 5000);
        sftp.readdir(workdir, function(err, list) {
            clearTimeout(to);
            //if(t == null) return; //timeout already called
            if(err) {
                logger.debug("failed to readdir:"+workdir, err);
                //maybe it doesn't exist yet.. try to create it
                sftp.opendir(workdir, function(err) {
                    if(err) return cb(null, "failed", "can't access workdir"); //ok, it looks like no good
                    cb(null, "ok", "ssh connection is good and workdir is accessible (created)");
                });
            } else {
                logger.debug("got dir", list);
                //clearTimeout(t);
                cb(null, "ok", "ssh connection is good and workdir is accessible");
            }
        });
    });
}

