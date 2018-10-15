'use strict';

//contrib
const winston = require('winston');
const async = require('async');
const Client = require('ssh2').Client;
const fs = require('fs');

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
    .exec((err, resources)=>{
        if(err) return cb(err);
        if(task.preferred_resource_id) logger.info("user preferred_resource_id:"+task.preferred_resource_id);

        //select the best resource based on the task
        var best = null;
        var best_score = null;
        var considered = [];
        async.eachSeries(resources, (resource, next_resource)=>{
            score_resource(user, resource, task, (err, score, detail)=>{

                if(score === null) {
                    //not configured to run on this resource.. ignore
                    return next_resource();         
                }

                let resource_detail = config.resources[resource.resource_id];
                let consider = {
                    id: resource._id, 
                    name: resource.name, 
                    desc: resource.desc, 
                    status: resource.status, 
                    status_msg: resource.status_msg, 
                    score: score, 
                    owner: resource.user_id,
                    detail, //{msg: .., maxtask: 10, running: 5}
                    info: {
                        desc: resource_detail.desc,
                        name: resource_detail.name,
                        maxtask: resource_detail.maxtask,
                    },
                };
                considered.push(consider);

                if(resource.status != 'ok') {
                    consider.detail.msg += "resource status is not ok";
                    return next_resource();
                }

                //if score is 0, assume it's disabled..
                if(score === 0) {
                    consider.detail.msg+="score is set to 0.. not running here";
                    return next_resource();
                }
               
                //for niced tasks, make sure resource score is at least greater than nide. 
                //this make niced tasks to not submit on low score resources to allow for non-nice 
                //jobs. For example, rule submitted jobs won't be using brainlife's UI staging resource to stage
                //input datasets there.
                if(task.nice) {
                    if(consider.score < task.nice) {
                        consider.detail.msg+="score lower than "+task.nice+". not running here\n";
                        return next_resource();
                    }
                }

                /*
                //don't let nice tasks take up all resources.
                if(task.nice && consider.detail.fullness) {
                    if(consider.detail.fullness > .9) {
                        consider.detail.msg+="resource is >90% full. and this is niced task.. not running here";
                        return next_resource();
                    }
                }
                */
                
                //+5 if resource is listed in dep
                if(~dep_resource_ids.indexOf(resource._id.toString())) {
                    consider.detail.msg+="resource listed in deps/resource_ids.. +5\n";
                    consider.score = score+5;
                }

                //+10 score if it's owned by user
                if(resource.user_id == user.sub) {
                    consider.detail.msg+="user owns this.. +10\n";
                    consider.score = score+10;
                }
                
                //+15 score if it's preferred by user (TODO need to make sure this still works)
                if(task.preferred_resource_id && task.preferred_resource_id == resource._id.toString()) {
                    consider.detail.msg+="user prefers this.. +15\n";
                    consider.score = score+15;
                }

                consider.detail.msg+="final score:"+consider.score+"\n";

                //pick the best score...
                if(!best || consider.score > best_score) {
                    best_score = consider.score;
                    best = resource;
                } 
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
        return cb(null, 0, {msg: "no resource_detail"});
    } else {
        var score = null;
        var detail = {msg: ""};
    
        //first, pull score from resource_detail
        if(resource_detail.services && resource_detail.services[task.service]) {
            score = parseInt(resource_detail.services[task.service].score);
            detail.msg += "resource_detail score:"+score+"\n";
        }
        
        //override it with instance specific score
        if( resource.config && 
            resource.config.services) {
            resource.config.services.forEach(function(service) {
                if(service.name == task.service) {
                    score = parseInt(service.score);
                    detail.msg += "resource.config score:"+score+"\n";
                }
            });
        }

        if(score === null) return cb(null, null); //this resource doesn't know about this service..

        //check number of tasks currently running on this resource and compare it with maxtask if set
        detail.maxtask = resource_detail.maxtask;
        //override with resource specific maxtask
        if(resource.config && resource.config.maxtask) detail.maxtask = resource.config.maxtask; 
        
        //if no maxtask set .. limitless!
        if(detail.maxtask === null || detail.maxtask === undefined) {
            detail.msg += "This resource has no max task";
            return cb(null, score, detail); 
        }

        db.Task.find({
            resource_id: resource._id, 
            $or: [
                {status: "running"},
                {status: "requested", start_date: {$exists: true}}, //starting..
            ],
            _id: {$ne: task._id}, //don't count myself waiting
        }, (err, tasks)=>{
            if(err) logger.error(err);
            detail.running = tasks.length;
            detail.msg+="tasks running:"+tasks.length+" maxtask:"+detail.maxtask+"\n";
            detail.fullness = detail.running / detail.maxtask;
            if(detail.fullness >= 1) {
                detail.msg += "resource is busy\n";
                cb(null, 0, detail); 
            } else {
                detail.msg += "resource is "+Math.round(detail.fullness*100)+"% occupied\n";
                cb(null, score, detail);
            }
        });
    }
}

//run appropriate tests based on resource type
exports.check = function(resource, cb) {
    var detail = config.resources[resource.resource_id];
    if(detail === undefined) return cb("unknown resource_id:"+resource.resource_id);
    //if(detail.type === undefined) return cb(resource.resource_id+" doesn't have type defined.. don't know how to check");
    /*
    switch(detail.type) {
    case "ssh":
        check_ssh(resource, update_status);
        break;
    default: 
        //update_status(null, "ok", "Don't know how to check "+resource.type + " .. assuming it to be ok");
        check_hpss(resource, update_status);
    }
    */
    check_ssh(resource, (err, status, msg)=> {
        if(err) return cb(err);
        logger.info("resource_id: "+resource._id+" status:"+status+" msg:"+msg);
        resource.status = status;
        resource.status_update = new Date();
        if(status == "ok") {
            resource.lastok_date = new Date();
            resource.status_msg = "test ok";
        } else {
            resource.status_msg = "test failed";
        }
        resource.save(function(err) {
            cb(err, {status, message: msg});
        });
    });
}

/*
function check_hpss(resource, cb) {
    //find best resource to run hpss
    common.ls_hpss(resource, "./", function(err, files) {
        if(err) return cb(null, "failed", err);
        cb(null, "ok", "hsi/ls returned "+files.length+" files on home directory");
    });
}
*/

//TODO this is too similar to common.js:ssh_command... can we refactor?
function check_ssh(resource, cb) {
    var conn = new Client();
    var ready = false;

    function cb_once(err, status, message) {
        if(cb) {
            cb(err, status, message);
            cb = null;
        } else {
            logger.error("cb already called", err, status, message);
        }

        conn.end();
    }
    
    //TODO - I think I should add timeout in case resource is down (default timeout is about 30 seconds?)
    conn.on('ready', function() {
        ready = true;

        //send test script
        var workdir = common.getworkdir(null, resource);
        conn.sftp((err, sftp)=>{
            if(err) return cb_once(err);

            var to = setTimeout(()=>{
                cb_once(null, "failed", "send test script timeout - filesytem is offline?");
            }, 5*1000); 
            
            let readstream = fs.createReadStream(__dirname+"/resource_test.sh");
            let writestream = sftp.createWriteStream(workdir+"/resource_test.sh");
            writestream.on('close', ()=>{
                clearTimeout(to);
                logger.debug("resource_test.sh write stream closed - running resource_test.sh");
                conn.exec('cd '+workdir+' && bash resource_test.sh', (err, stream)=>{
                    if (err) return cb_once(err);
                    var out = "";
                    stream.on('close', function(code, signal) {
                        logger.debug(out);
                        if(code == 0) cb_once(null, "ok", out);
                        else cb_once(null, "failed", out);
                    }).on('data', function(data) {
                        out += data;
                    }).stderr.on('data', function(data) {
                        out += data;
                    });
                })
            });
            writestream.on('error', err=>{
                logger.debug("resource_test.sh write stream errored");
                clearTimeout(to);
                if(err) return cb_once(null, "failed", "failed to stream resource_test.sh");
            });
            writestream.on('end', ()=>{
                logger.debug("resource_test.sh write stream ended - running");
            });
            readstream.pipe(writestream);
        });


        /*
        check_sftp(resource, conn, function(err, status, msg) {
            if(err) return cb_once(err);
            if(status != "ok") return cb_once(null, status, msg);

            //send resource test script
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
        */

        /*
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
        */
    });
    conn.on('end', function() {
        logger.debug("ssh connection ended");
    });
    conn.on('close', function() {
        logger.debug("ssh connection closed");
        if(!ready && cb) {
            cb(null, "failed", "Connection closed before becoming ready.. probably in maintenance mode?");
            cb = null;
        }
    });
    conn.on('error', function(err) {
        if(cb) cb(null, "failed", err.toString());
        cb = null;
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

