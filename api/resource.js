'use strict';

const async = require('async');
const Client = require('ssh2').Client;
const fs = require('fs');

const config = require('./config');
const db = require('./models');
const common = require('./common');

//task needs to have populated deps
exports.select = function(user, task, cb) {
    //select all resource available for the user and active

    //pull resource_ids of deps so that we can raise score on resource where deps exists
    var dep_resource_ids = [];
    if(task.deps_config) task.deps_config.forEach(dep=>{
        dep.task.resource_ids.forEach(id=>{
            id = id.toString();
            if(!~dep_resource_ids.indexOf(id)) dep_resource_ids.push(id);
        });
    });

    //admin can request task to run on the followed resource
    if(task.follow_task_id) {
        db.Resource.findById(task.follow_task_id.resource_id)
        .lean()
        .exec((err, resource)=>{
            if(err) return cb(err);
            let best = null;
            if(resource.active) best = resource;
            return cb(err, resource, null, []);
        });
        return;
    }

    //now let's start out by all the resources that user has access and app is enabled on
    db.Resource.find({
        status: {$ne: "removed"},
        active: true,
        gids: {"$in": task.gids},
        'config.services.name': task.service,
    }).lean().sort('create_date').exec((err, resources)=>{
        if(err) return cb(err);

        //select the best resource based on the task
        var best = null;
        var best_score = null;
        var considered = [];
        async.eachSeries(resources, (resource, next_resource)=>{
            score_resource(user, resource, task, (err, score, detail)=>{
                if(score === null) {
                    //not configured to run on this resource.. ignore
                    //console.log("no score produced for "+resource.name);
                    return next_resource();         
                }

                let consider = {
                    _id: resource._id, 
                    id: resource._id,  //deprecated.. use _id
                    gids: resource.gids,
                    name: resource.name, 
                    config: {
                        desc: resource.config.desc,
                        maxtask: resource.config.maxtask,
                    },
                    status: resource.status, 
                    status_msg: resource.status_msg, 
                    active: resource.active,

                    score,
                    detail, //score details

                    stats: resource.stats,

                    owner: resource.user_id,
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

                //+5 if resource is listed in dep
                if(~dep_resource_ids.indexOf(resource._id.toString())) {
                    consider.detail.msg+="resource listed in deps/resource_ids.. +5\n";
                    consider.score = score+5;
                }
                
                //+10 if it's private resource
                if(resource.gids.length == 0) {
                    consider.detail.msg+="private resource.. +10\n";
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
                console.debug("best resource chosen:"+best._id+" name:"+best.name+" with score:"+best_score);
            } 
            cb(err, best, best_score, considered);
        });
    });
}

function score_resource(user, resource, task, cb) {
    //see if this resource supports requested service
    //var resource_detail = config.resources[resource.resource_id];
    //TODO other things we could do..
    //1... handle task.other_service_ids and give higher score to resource that provides more of those services
    //2... benchmark performance from service test and give higher score on resource that performs better at real time
    
    //override it with instance specific score
    let score = null;
    if( resource.config && 
        resource.config.services) {
        resource.config.services.forEach(function(service) {
            if(service.name == task.service) {
                score = parseInt(service.score);
            }
        });
    }
    if(score === null)  return cb(null, null); //this resource doesn't know about this service..

    let maxtask = resource.config.maxtask;
    if(maxtask === undefined) maxtask = 1; //backward compatibility
    if(maxtask == 0) return cb(null, null); //can't run here

    db.Task.countDocuments({
        _id: {$ne: task._id}, //don't count myself waiting
        resource_id: resource._id, 
        $or: [
            {
                status: "running",
            },
            {
                status: "requested", 
                start_date: {$exists: true},
            }, //starting..
        ],
    }, (err, running)=>{
        if(err) console.error(err);

        let msg = "resource.config score:"+score+"\n";
        msg+="tasks running:"+running+" maxtask:"+maxtask+"\n";

        let fullness = running / maxtask;
        if(fullness >= 1) {
            score = 0;
            msg += "resource is busy\n";
        }

        msg += "resource is "+Math.round(fullness*100)+"% occupied\n";
        cb(null, score, {running, msg, maxtask, fullness});
    });
}

//run appropriate tests based on resource type
//TODO maybe I should move this to common?
exports.check = function(resource, cb) {
    //var detail = config.resources[resource.resource_id];
    //if(detail === undefined) return cb("unknown resource_id:"+resource.resource_id);

    let status; //ok, failed, etc..
    let msg; //detail

    async.series([

        //check for ssh host
        next=>{
            check_ssh(resource, (err, _status, _msg)=>{
                if(err) return next(err);
                status = _status;
                msg = _msg;
                console.log("ssh check / resource_id: "+resource._id+" name: "+resource.name+" status:"+status+" msg:"+msg);
                next();
            });
        },

        //check for io host
        next=>{
            if(status != "ok") return next(); //no point of checking..
            if(!resource.config.io_hostname) return next();
            check_iohost(resource, (err, _status, _msg)=>{
                if(err) return next(err);
                status = _status;
                msg = _msg;
                console.log("iohost check / resource_id: "+resource._id+" name: "+resource.name+" status:"+status+" msg:"+msg);
                next();
            });
        },

        //update resource record
        next=>{
            resource.status_update = new Date(); //why doesn't this happen automatically?
            resource.status = status;
            if(status == "ok") {
                resource.lastok_date = new Date();
                resource.status_msg = "Resource tested successfully";
            } else {
                resource.status_msg = msg || "test failed";
            }
            resource.save(next);
        },
    ], err=>{
        cb(err, {status, message: msg});
    });

}

//TODO this is too similar to common.js:ssh_command... can we refactor?
function check_ssh(resource, cb) {
    var conn = new Client();
    var ready = false;

    function cb_once(err, status, message) {
        if(cb) {
            cb(err, status, message);
            cb = null;
        } else {
            //console.error("cb already called", err, status, message);
        }

        console.log("closing connection", resource.name);
        conn.end();
    }

    //TODO - I think I should add timeout in case resource is down (default timeout is about 30 seconds?)
    conn.on('ready', function() {
        ready = true;

        //send test script
        const workdir = common.getworkdir(null, resource);
        let t1 = setTimeout(()=>{
            cb_once(null, "failed", "got ssh connection but sftp timeout");
            t1 = null;
        }, 15*1000); //10 sec too short for osgconnect
        conn.sftp((err, sftp)=>{
            if(!t1) return; //timed out already
            clearTimeout(t1);

            if(err) return cb_once(err);
            let to = setTimeout(()=>{
                cb_once(null, "failed", "send test script timeout(10sec) - filesytem is offline?");
                to = null;
            }, 10*1000); 

            let readstream = fs.createReadStream(__dirname+"/resource_test.sh");
            let writestream = sftp.createWriteStream(workdir+"/resource_test.sh");
            writestream.on('close', ()=>{
                if(!to) return; //timed out already
                clearTimeout(to);
                console.debug("resource_test.sh write stream closed - running resource_test.sh");
                conn.exec('cd '+workdir+' && timeout 10 bash resource_test.sh', (err, stream)=>{
                    if (err) return cb_once(err);
                    var out = "";
                    stream.on('close', function(code, signal) {
                        console.debug(out);
                        if(code == 0) cb_once(null, "ok", out);
                        else cb_once(null, "failed", out);
                    }).on('data', function(data) {
                        out += data;
                    }).stderr.on('data', function(data) {
                        console.log("stderr:"+data);
                        out += data;
                    });
                })
            });
            writestream.on('error', err=>{
                console.debug("resource_test.sh write stream errored");
                if(!to) return; //timed out already
                clearTimeout(to);
                if(err) return cb_once(null, "failed", "failed to stream resource_test.sh");
            });
            writestream.on('end', ()=>{
                console.debug("resource_test.sh write stream ended - running");
            });
            readstream.pipe(writestream);
        });
    });
    conn.on('end', function() {
        console.debug("ssh connection ended");
    });
    conn.on('close', function() {
        console.debug("ssh connection closed");
        if(!ready) {
            cb_once(null, "failed", "Connection closed before becoming ready.. probably in maintenance mode?");
        }
    });
    conn.on('error', function(err) {
        cb_once(null, "failed", err.toString());
    });

    //clone resource so that decrypted content won't leak out of here
    var decrypted_resource = JSON.parse(JSON.stringify(resource));
    common.decrypt_resource(decrypted_resource);
    //console.debug("check_ssh / decrypted");
    try {
        conn.connect({
            host: resource.config.hostname,// || detail.hostname,
            username: resource.config.username,
            privateKey: decrypted_resource.config.enc_ssh_private,
            //debug: console.debug,
            //no need to set keepaliveInterval(in millisecond) because checking resource should take less than a second
            tryKeyboard: true, //needed by stampede2
        });
    } catch (err) {
        cb_once(null, "failed", err.toString());
    }
}

//TODO this is too similar to common.js:ssh_command... can we refactor?
function check_iohost(resource, cb) {
    var conn = new Client();
    var ready = false;

    function cb_once(err, status, message) {
        if(cb) {
            cb(err, status, message);
            cb = null;
        } else {
            //console.error("cb already called", err, status, message);
        }

        console.log("closing connection (iohsot)", resource.name);
        conn.end();
    }

    //TODO - I think I should add timeout in case resource is down (default timeout is about 30 seconds?)
    conn.once('ready', function() {
        ready = true;

        const workdir = common.getworkdir(null, resource);
        let t1 = setTimeout(()=>{
            cb_once(null, "failed", "got io ssh connection but sftp timeout");
            t1 = null;
        }, 15*1000); //10 sec too short for osgconnect
        conn.sftp(function(err, sftp) {
            if(!t1) return; //timed out already
            clearTimeout(t1);

            if(err) return cb_once(err);
            let to = setTimeout(()=>{
                cb_once(null, "failed", "readdir timeout - filesytem is offline?");
                to = null;
            }, 3*1000);
            sftp.opendir(workdir, function(err, stat) {
                if(!to) return; //timed out already
                clearTimeout(to);

                if(err) return cb_once(null, "failed", "can't access workdir");
                cb_once(null, "ok", "workdir is accessible");
                //TODO - I should probably check to see if I can write to it
            });
        });
    });
    conn.on('end', function() {
        console.debug("ssh connection ended");
    });
    conn.on('close', function() {
        console.debug("ssh connection closed");
        if(!ready) {
            cb_once(null, "failed", "Connection closed before becoming ready.. probably in maintenance mode?");
        }
    });
    conn.on('error', function(err) {
        cb_once(null, "failed", err.toString());
    });

    var decrypted_resource = JSON.parse(JSON.stringify(resource));
    common.decrypt_resource(decrypted_resource);
    try {
        conn.connect({
            host: resource.config.io_hostname,
            username: resource.config.username,
            privateKey: decrypted_resource.config.enc_ssh_private,
        });
    } catch (err) {
        cb_once(null, "failed", err.toString());
    }
}

//pull some statistics about a resource
//used by bin/resource.js
exports.stat = async function(resource, cb) {
    try {
        //get execution history counts for each service 
        let data = await db.Taskevent.aggregate()
            .match({resource_id: resource._id, status: {$in: ["running", "finished", "failed"]}}) //reuqested doesn't get resource_id
            .group({_id: {service: '$service', status: '$status'}, count: {$sum: 1}}).exec()
        let total = {};
        let services = {};
        data.forEach(rec=>{
            let service = rec._id.service;
            let status = rec._id.status;
            let count = rec.count;

            if(!total[status]) total[status] = 0;
            if(!services[service]) services[service] = {};
            if(!services[service][status]) services[service][status] = 0;
            total[status] += count;
            services[service][status] += count;
        });
        cb(null, {total, services});
    } catch (err) {
        cb(err);
    }
}

