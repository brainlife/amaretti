'use strict';

//contrib
const winston = require('winston');
const async = require('async');
const Client = require('ssh2').Client;

//mine
const config = require('../config');
const logger = new winston.Logger(config.logger.winston);
const db = require('./models');
const common = require('./common');

//task needs to have populated deps
exports.select = function(user, task, cb) {
    //select all resource available for the user and active
    logger.debug("finding resource to run .select task_id:",task._id,"service:",task.service,"branch:",task.service_branch,"user:",user.sub,"deps:");

    //pull resource_ids of deps so that we can raise score on resource where deps exists
    var dep_resource_ids = [];
    if(task.deps) {
        task.deps.forEach(dep=>{
            dep.resource_ids.forEach(id=>{
                id = id.toString();
                if(!~dep_resource_ids.indexOf(id)) dep_resource_ids.push(id);
            });
        });
    }

    //load resource that user has access
    db.Resource.find({
        "$or": [
            {user_id: user.sub},
            {gids: {"$in": common.get_user_gids(user)}},
        ],
        status: {$ne: "removed"},
        active: true,
    })
    .sort('create_date')
    .exec(function(err, resources) {
        if(err) return cb(err);
        if(task.preferred_resource_id) logger.info("user preferred_resource_id:"+task.preferred_resource_id);

        //select the best resource based on the task
        var best = null;
        var best_score = null;
        var considered = [];
        async.eachSeries(resources, (resource, next_resource)=>{
            //logger.debug(resource.name);
            score_resource(user, resource, task, (err, score, detail)=>{
                if(score === null) {
                    //not configured to run on this resource.. ignore
                    return next_resource();         
                }

                if(resource.status != 'ok') {
                    //logger.debug("  resource status not ok");
                    detail += "resource status not ok";
                    considered.push({id: resource._id, name: resource.name, status: resource.status, score: 0, detail});
                    return next_resource();
                }

                if(score == 0) {
                    considered.push({id: resource._id, name: resource.name, status: resource.status, score, detail});
                    return next_resource();
                }
                
                //+5 if resource is listed in dep
                if(~dep_resource_ids.indexOf(resource._id.toString())) {
                    detail+="resource listed in deps/resource_ids.. +5\n";
                    score = score+5;
                }

                //+10 score if it's owned by user
                if(resource.user_id == user.sub) {
                    detail+="user owns this.. +10\n";
                    score = score+10;
                }
                //+15 score if it's preferred by user (TODO need to make sure this still works)
                if(task.preferred_resource_id && task.preferred_resource_id == resource._id.toString()) {
                    detail+="user prefers this.. +15\n";
                    score = score+15;
                }

                detail+="final score:"+score+"\n";

                //pick the best score...
                if(!best || score > best_score) {
                    best_score = score;
                    best = resource;
                } 

                considered.push({id: resource._id, name: resource.name, status: resource.status, score, detail});
                next_resource();
            });
        }, err=>{
            //for debugging
            if(best) {
                logger.debug("best resource chosen:"+best._id+" name:"+best.name+" with score:"+best_score);
            } else {
                logger.debug("no resource matched to run this task :)");
                //console.dir(considered);
            } 
            cb(err, best, best_score, considered);
        });
    });
}

function score_resource(user, resource, task, cb) {
    //see if this resource supports requested service
    var resource_detail = config.resources[resource.resource_id];
    //TODO other things we could do..
    //1... handle task.other_service_ids and give higher score to resource that provides more of those services
    //2... benchmark performance from service test and give higher score on resource that performs better at real time
    if(!resource_detail) {
        logger.error("  resource detail no longer exists for resource_id:"+resource.resource_id);
        return cb(null, 0, "no resource_detail");
    } else {
        var score = null;
        var detail = "";
    
        //first, pull score from resource_detail
        if( resource_detail.services &&
            resource_detail.services[task.service]) {
            score = parseInt(resource_detail.services[task.service].score);
            detail += "resource_detail score:"+score+"\n";
        }
        
        //override it with instance specific score
        if( resource.config && 
            resource.config.services) {
            resource.config.services.forEach(function(service) {
                if(service.name == task.service) {
                    score = parseInt(service.score);
                    detail += "resource.config score:"+score+"\n";
                }
            });
        }

        //check number of tasks currently running on this resource and compare it with maxtask if set
        var maxtask = resource_detail.maxtask;
        if(resource.config && resource.config.maxtask) maxtask = resource.config.maxtask; //override with resource specific maxtask
        if(!maxtask) return cb(null, score, detail); //no maxtask set.. don't need to check
        db.Task.find({
            resource_id: resource._id, 
            $or: [
                {status: "running"},
                {status: "requested", start_date: {$exists: true}}, //starting..
            ],
            _id: {$ne: task._id}, //don't count myself waiting
        }, (err, tasks)=>{
            if(err) logger.error(err);
            detail+="tasks running:"+tasks.length+" maxtask:"+maxtask+"\n";
            if(maxtask < tasks.length) {
                detail += "resource is busy\n";
                cb(null, 0, detail); 
            } else {
                cb(null, score, detail);
            }
        });
    }
}

//run appropriate tests based on resource type
exports.check = function(resource, cb) {
    var detail = config.resources[resource.resource_id];
    if(detail === undefined) return cb("unknown resource_id:"+resource.resource_id);
    if(detail.type === undefined) return cb(resource.resource_id+" doesn't have type defined.. don't know how to check");

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
    //TODO - I think I should add timeout in case resource is down (default timeout is about 30 seconds?)
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
//TODO - I should also check to make sure that I can write to workdir
function check_sftp(resource, conn, cb) {
    var workdir = common.getworkdir(null, resource);
    conn.sftp(function(err, sftp) {
        if(err) return cb(err);
        logger.debug("reading dir "+workdir);
        var to = setTimeout(()=>{
            logger.error("readdir timeout"); 
            cb(null, "failed", "readdir timeout - filesytem is offline?");
        }, 3*1000); 
        
        sftp.opendir(workdir, function(err, stat) {
            clearTimeout(to);
            if(err) return cb(null, "failed", "can't access workdir");
            cb(null, "ok", "workdir is accessible");
            //TODO - I should probably check to see if I can write to it
        });
    });
}

//pull some statistics about this resource using taskevent table (should we create another table to store this?)
exports.stat = function(resource, cb) {
    var find = {resource_id: resource._id};

    //group by status and count
    db.Taskevent.aggregate([
        {$match: find},
        {$group: {_id: '$status', count: {$sum: 1}}},
    ]).exec(function(err, statuses) {
        if(err) return cb(err);

        var task_status_counts = {};
        statuses.forEach(status=>{
            task_status_counts[status._id] = status.count;
        });
        
        //group by service and count
        db.Taskevent.aggregate([
            {
                $match: { 
                    resource_id: resource._id,
                    //status: "requested",
                }
            },
            {$group: {_id: {
                service: '$service',
                status: '$status',
                /*, service_branch: '$service_branch'*/
            }, count: {$sum: 1}}},
        ]).exec(function(err, services) {
            if(err) return cb(err);
            cb(null, { find, counts: task_status_counts, services });
        });

        /*
        //count distinct service requested
        //TODO is there a better way?
        db.Taskevent.find(find).distinct('service').exec(function(err, services) {
            if(err) return cb(err);
            cb(null, { find, task_status_counts, services });
        });
        */
    });
}

