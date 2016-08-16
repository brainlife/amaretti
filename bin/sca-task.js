#!/usr/bin/node
'use strict';

//node
const fs = require('fs');
const path = require('path');
const os = require('os');
const request = require('request');

//contrib
const winston = require('winston');
const async = require('async');
const Client = require('ssh2').Client;

//mine
const config = require('../config');
const logger = new winston.Logger(config.logger.winston);
const db = require('../api/models/db');
const common = require('../api/common');
const _resource_picker = require('../api/resource').select;
const _transfer = require('../api/transfer');
const _service = require('../api/service');

db.init(function(err) {
    if(err) throw err;
    //start check loop
    check(); 
});

/*
//now that I am looking for requested task that's handled_date that's old enough,
//I shouldn't have to look for stuck tasks
function check_stuck() {
    logger.debug("checking for handled tasks that got stuck");
    var whileago = new Date();
    whileago.setHours(whileago.getHours()-1);
    db.Task
    .find({
        "_handled.timestamp": { $lt: whileago }
    })
    .exec(function(err, tasks) {
        if(err) throw err;
        tasks.forEach(function(task) {
            logger.error("detected stuck request.. please find out why this got stuck (unstucking it for now..)");
            logger.error(JSON.stringify(task, null, 4));
            task.status_msg = "Request handled but got stuck.. trying again.";
            task._handled = undefined; //this is how you *delete*
            task.save();
        });
        //wait for the next round
        setTimeout(check_stuck, 1000*30);
    });
} 
*/

//set next_date incrementally longer between each checks
function set_nextdate(task) {
    task.next_date = new Date();
    if(task.start_date) {
        var start = task.start_date.getTime();
        var elapsed = task.next_date.getTime() - start;
        //logger.debug("elapsed seconds: "+elapsed);
        var next = task.next_date.getTime() + elapsed/2;
        task.next_date.setTime(next);
    } else {
        //not yet started. check again in 10 minutes (maybe resource issue?)
        //maybe I should increase the delay to something like an hour?
        task.next_date.setMinutes(task.next_date.getMinutes() + 10);
    }
}

function check() {
    //logger.info("checking..");
    db.Task.find({
        status: {$ne: "removed"}, //ignore removed tasks
        $or: [
            {next_date: {$exists: false}},
            {next_date: {$lt: new Date()}}
        ] 
    })
    
    //maybe I should do these later (only needed by requested task)
    .populate('deps', 'status resource_id')
    .populate('resource_deps') 
    .exec((err, tasks) => {
        if(err) throw err;
        async.eachSeries(tasks, (task, next) => {
            logger.info("handling task:"+task._id);
            switch(task.status) {
            case "requested":
                handle_requested(task, next); 
                break;
            case "stop_requested":
                handle_stop(task, next); 
                break;
            case "running":
                handle_running(task, next); 
                break;
            default:
                handle_housekeeping(task, next);
            }
            set_nextdate(task);
            logger.debug("reset next_date: "+task.next_date);
            task.save();
        }, function(err) {
            if(err) logger.error(err);
            //wait a bit and recheck again
            setTimeout(check, 500);
        });
    });
}

function handle_housekeeping(task, cb) {
    //.. if to remove, iterate through all resources that this task has run or synchornized to)
    logger.debug("handling book keeping "+task._id);

    async.series([
        //remove task dir?
        function(next) {
            var need_remove = false;
            
            //check for early remove specified by user
            var now = new Date();
            if(task.remove_date && task.remove_date < now) {
                logger.info("remove_date is set and task is passed the date");
                need_remove = true;
            }
            
            //check for max life time
            var maxage = new Date();
            maxage.setDate(now.getDate() - 25); //25 days max (TODO - use resource's configured data)
            if(task.request_date < maxage) {
                logger.info("this task was requested more than specified days ago..");
                need_remove = true;
            }
        
            if(!need_remove) return next();

            //if job is still running/running_sync, then I need to first stop it
            if(task.status == "running") {
                task.status = "stop_requested";
                task.status_msg = "";
                task.save(next);
                return;
            }
            if(task.status == "running_sync") {
                logger.debug("TODO - can't remove task that's still running_sync - maybe stuck?");
                return next();
            }

            logger.info("need to remove this task. resource_ids.length:"+task.resource_ids.length);
            async.forEach(task.resource_ids, function(resource_id, next_resource) {
                db.Resource.findById(resource_id, function(err, resource) {
                    if(resource.status != "ok") {
                        logger.info("couldn't fail taskdir from resource_id:"+resource._id.toString()+" because resource status is not ok");
                        return next_resource();
                    }
                    common.get_ssh_connection(resource, function(err, conn) {
                        if(err) return next_resource(err);
                        var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
                        if(!taskdir || taskdir.length < 10) return next_resource("taskdir looks odd.. bailing");
                        logger.info("rm -rf "+taskdir);
                        conn.exec("rm -rf "+taskdir, function(err, stream) {
                            if(err) return next_resource(err);
                            stream.on('close', function(code, signal) {
                                if(code) return next_resource("Failed to remove taskdir "+taskdir);
                                else next_resource();
                            })
                            .on('data', function(data) {
                                logger.info(data.toString());
                            }).stderr.on('data', function(data) {
                                logger.error(data.toString());
                            });
                        });
                    });
                });
            }, function(err) {
                if(err) {
                    logger.error(err); //continue 
                    next();
                } else {
                    //done with removeal
                    task.status = "removed";
                    task.status_msg = "taskdir removed from all resources";

                    //reset resource ids
                    task.resource_id = undefined; //I wonder if I should keep this, but UI often depends on this to mean that task is executed
                    task.resource_ids = []; 

                    task.save(next);

                    //also post to progress.. (TODO - should I set the status?)
                    common.progress(task.progress_key, {msg: 'Task directory Removed'});
                }
            });
        }

        //onto.. next housekeeping task..
        //TODO - stop tasks that got stuck in running / running_sync

    ], function(err) {
        //done with all house keeping..
        if(err) logger.error(err); //skip this task
        cb();
    });
}

function handle_requested(task, next) {
    //make sure dependent tasks has all finished
    var deps_all_done = true;
    task.deps.forEach(function(dep) {
        if(dep.status != "finished") deps_all_done = false; 
    });
    if(!deps_all_done) {
        logger.debug("dependency not met.. postponing");
        task.status_msg = "Waiting on dependency";
        next();
        return;
    }

    logger.debug(JSON.stringify(task, null, 4));
    
    //need to lookup user's gids to find all resources that user has access to
    request.get({
        url: config.api.auth+"/user/groups/"+task.user_id,
        json: true,
        headers: { 'Authorization': 'Bearer '+config.sca.jwt }
    }, function(err, res, gids) {
        if(err) return next(err);
      
        //then pick best resource
        _resource_picker({
            sub: task.user_id,
            gids: gids,
        }, {
            service: task.service,
            preferred_resource_id: task.preferred_resource_id //user preference (most of the time not set)
        }, function(err, resource) {
            if(err) return next(err);
            if(!resource) {
                task.status_msg = "No resource available to run this task.. postponing.";
                task.save(next);
                return;
            }
            task.resource_id = resource._id;
            
            //shouldn't be neede in the future.. since this should be initialized when task is requested
            if(!task.resource_ids) task.resource_ids = []; 
            //register this resource as task_dir
            if(!~task.resource_ids.indexOf(resource._id)) task.resource_ids.push(resource._id);

            common.progress(task.progress_key, {status: 'running', progress: 0, msg: 'Initializing'});
            start_task(task, resource, function(err) {
                if(err) {
                    //failed to start (or running_sync failed).. mark the task as failed
                    common.progress(task.progress_key, {status: 'failed', msg: err.toString()});
                    logger.error(err); 
                    task.status = "failed";
                    task.status_msg = err;
                    task.save();
                }
                //next();
            });

            //don't wait for start_task to end.. start next task concurrently
            next(); 
        });
    });
}

function handle_stop(task, next) {
    logger.info("handling stop request:"+task._id);
    db.Resource.findById(task.resource_id, function(err, resource) {
        if(err) {
            logger.error(err);
            return next(); //skip this task
        }

        get_service(task.service, function(err, service_detail) {
        //db.Service.findOne({name: task.service}, function(err, service_detail) {
            if(err) {
                logger.error("Couldn't find such service:"+task.service);
                return next(); //skip this task
            }
            if(!service_detail.pkg || !service_detail.pkg.scripts || !service_detail.pkg.scripts.stop) {
                logger.error("service:"+task.service+" doesn't have scripts.stop defined.. marking as finished");
                //console.dir(service_detail.pkg.scripts);
                task.status = "stopped";
                task.status_msg = "Stopped by user";
                task.save(next);
                return;
            }

            common.get_ssh_connection(resource, function(err, conn) {
                var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
                conn.exec("cd "+taskdir+" && ./_stop.sh", {}, function(err, stream) {
                    if(err) return next(err);
                    stream.on('close', function(code, signal) {
                        logger.debug("stream closed "+code);
                        task.status = "stopped";
                        switch(code) {
                        case 0: //cleanly stopped
                            task.status_msg = "Cleanly stopped by user";
                            task.save(next);
                            break;
                        default:
                            task.status_msg = "Failed to stop the task cleanly -- code:"+code;
                            task.save(next);
                        }
                    })
                    .on('data', function(data) {
                        logger.info(data.toString());
                    }).stderr.on('data', function(data) {
                        logger.debug("receiveed stderr");
                        logger.error(data.toString());
                    });
                });
            });
        });
    });
}

//check for task status of already running tasks
function handle_running(task, next) {
    logger.info("check_running "+task._id);
    
    //TODO - request stop job that are stuck running for long time (look start_date)

    db.Resource.findById(task.resource_id, function(err, resource) {
        if(err) return next(err);
        if(!resource) return next(new Error("can't find such resource:"+task.resource_id));
        common.get_ssh_connection(resource, function(err, conn) {
            var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
            //TODO - not all service provides bin.status.. how will this handle that?
            logger.debug("cd "+taskdir+" && ./_status.sh");
            conn.exec("cd "+taskdir+" && ./_status.sh", {}, function(err, stream) {
                if(err) return next(err);
                var out = "";
                stream.on('close', function(code, signal) {
                    switch(code) {
                    case 0: //still running
                        //set_nextdate(task);
                        next();
                        break;
                    case 1: //finished
                        load_products(task, taskdir, conn, function(err) {
                            if(err) {
                                common.progress(task.progress_key, {status: 'failed', msg: err.toString()});
                                task.status = "failed";
                                task.status_msg = err;
                                task.save(next);
                                return;
                            }
                            common.progress(task.progress_key, {status: 'finished', msg: 'Service Completed'});
                            task.status = "finished";
                            task.status_msg = "Service completed successfully";
                            task.finish_date = new Date();
                            task.save(function(err) {
                                //clear next_date on dependending tasks (not this task!) so that it will be checked immediately
                                db.Task.update({deps: task._id}, {$unset: {next_date: 1}}, next);
                            });
                        });
                        break;
                    case 2: //job failed
                        //TODO - let user specify retry count, and if we haven't met it, rerun it?
                        common.progress(task.progress_key, {status: 'failed', msg: 'Service failed'});
                        task.status = "failed"; 
                        task.status_msg = out;
                        task.save(next);
                        break; 
                    default:
                        //TODO - should I mark it as failed? or.. 3 strikes and out rule?
                        logger.error("unknown return code:"+code+" returned from _status.sh");
                        next();
                    }
                })
                .on('data', function(data) {
                    logger.info(data.toString());
                    out += data.toString();
                }).stderr.on('data', function(data) {
                    logger.error(data.toString());
                    out += data.toString();
                });
            });
        });
    });
}

/*
function process_requested(task, cb) {
    //need to lookup user's gids first
    request.get({
        url: config.api.auth+"/user/groups/"+task.user_id,
        json: true,
        headers: { 'Authorization': 'Bearer '+config.sca.jwt }
    }, function(err, res, gids) {
        if(err) return cb(err);
      
        //then pick best resource
        _resource_picker({
            sub: task.user_id,
            gids: gids,
        }, {
            service: task.service,
            preferred_resource_id: task.preferred_resource_id //user preference (most of the time not set)
        }, function(err, resource) {
            if(err) return cb(err);
            if(!resource) {
                task.status_msg = "No resource available to run this task.. postponing.";
                task.save(cb);
                return;
            }
            task.resource_id = resource._id;
            common.progress(task.progress_key, {status: 'running', progress: 0, msg: 'Initializing'});
            start_task(task, resource, function(err) {
                if(err) {
                    common.progress(task.progress_key, {status: 'failed', msg: err.toString()});
                    return cb(err);
                }
                cb();
            });
        });
    });
}
*/

//
function get_service(service_name, cb) {
    db.Service.findOne({name: service_name}, function(err, service_detail) {
        /*
        var old = new Date();
        old.setDate(old.getDate() - 1); //cache every day
        if(service_detail.cached_date > old) return cb(service_detail);
        */
        //update cache
        logger.info("caching service detail for "+service_name);
        _service.loaddetail(service_name, function(err, new_service_detail) {
            service_detail.cached_date = new Date();
            service_detail.git = new_service_detail.git; //not necessary?
            service_detail.pkg = new_service_detail.pkg;
            service_detail.save(function(err) {
                cb(err, service_detail);
            });
        });
    });
}

//initialize task and run or start the service
function start_task(task, resource, cb) {
    common.get_ssh_connection(resource, function(err, conn) {
        if(err) return cb(err);
        var service = task.service;
        if(service == null) return cb(new Error("service not set.."));

        //db.Service.findOne({name: service}, function(err, service_detail) {
        get_service(service, function(err, service_detail) {
            if(err) return cb(err);
            if(!service_detail) return cb("Couldn't find such service:"+service);
            if(!service_detail.pkg || !service_detail.pkg.scripts) return cb("package.scripts not defined");
            
            var workdir = common.getworkdir(task.instance_id, resource);
            var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
            var envs = {
                SCA_WORKFLOW_ID: task.instance_id.toString(),
                SCA_WORKFLOW_DIR: workdir,
                SCA_TASK_ID: task._id.toString(),
                SCA_TASK_DIR: taskdir,
                SCA_SERVICE: service,
                SCA_SERVICE_DIR: "$HOME/.sca/services/"+service,
                SCA_PROGRESS_URL: config.progress.api+"/status/"+task.progress_key/*+".service"*/,
            };
            task._envs = envs;
            
            //insert any task envs 
            if(task.envs) for(var key in task.envs) {
                envs[key] = task.envs[key];
            }
            //insert any resource envs
            if(resource.envs) for(var key in resource.envs) {
                envs[key] = resource.envs[key];
            }
            if(task.resource_deps) task.resource_deps.forEach(function(resource_dep) {
                if(resource_dep.envs) for(var key in resource_dep.envs) {
                    envs[key] = resource_dep.envs[key];
                }
            });

            async.series([
                function(next) {
                    common.progress(task.progress_key+".prep", {name: "Task Prep", status: 'running', progress: 0.05, msg: 'Installing sca install script', weight: 0});
                    conn.exec("mkdir -p ~/.sca && cat > ~/.sca/install.sh && chmod +x ~/.sca/install.sh", function(err, stream) {
                        if(err) return next(err);
                        stream.on('close', function(code, signal) {
                            if(code) return next("Failed to write ~/.sca/install.sh");
                            else next();
                        })
                        .on('data', function(data) {
                            logger.info(data.toString());
                        }).stderr.on('data', function(data) {
                            logger.error(data.toString());
                        });
                        fs.createReadStream(__dirname+"/install.sh").pipe(stream);
                    });
                },
                function(next) {
                    common.progress(task.progress_key+".prep", {progress: 0.3, msg: 'Running sca install script (might take a while for the first time)'});
                    conn.exec("cd ~/.sca && ./install.sh", function(err, stream) {
                        if(err) return next(err);
                        stream.on('close', function(code, signal) {
                            if(code) return next("Failed to run ~/.sca/install.sh");
                            else next();
                        })
                        .on('data', function(data) {
                            logger.info(data.toString());
                        }).stderr.on('data', function(data) {
                            logger.error(data.toString());
                        });
                    });
                },
                function(next) {
                    common.progress(task.progress_key+".prep", {progress: 0.5, msg: 'Installing/updating '+service+' service'});
                    var repo_owner = service.split("/")[0];
                    conn.exec("ls .sca/services/"+service+ " >/dev/null 2>&1 || (mkdir -p .sca/services/"+repo_owner+" && LD_LIBRARY_PATH=\"\" git clone "+service_detail.git.clone_url+" .sca/services/"+service+")", function(err, stream) {
                        if(err) return next(err);
                        stream.on('close', function(code, signal) {
                            if(code) return next("Failed to git clone. code:"+code);
                            else next();
                        })
                        .on('data', function(data) {
                            logger.info(data.toString());
                        }).stderr.on('data', function(data) {
                            logger.error(data.toString());
                        });
                    });
                },

                function(next) {
                    logger.debug("making sure requested service is up-to-date");
                    conn.exec("cd .sca/services/"+service+" && LD_LIBRARY_PATH=\"\" git pull", function(err, stream) {
                        if(err) return next(err);
                        stream.on('close', function(code, signal) {
                            if(code) return next("Failed to git pull in ~/.sca/services/"+service);
                            else next();
                        })
                        .on('data', function(data) {
                            logger.info(data.toString());
                        }).stderr.on('data', function(data) {
                            logger.error(data.toString());
                        });
                    });
                },
                
                function(next) {
                    common.progress(task.progress_key+".prep", {progress: 0.7, msg: 'Preparing taskdir'});
                    logger.debug("making sure taskdir("+taskdir+") exists");
                    conn.exec("mkdir -p "+taskdir, function(err, stream) {
                        if(err) return next(err);
                        stream.on('close', function(code, signal) {
                            if(code) return next("Failed create taskdir:"+taskdir);
                            else next();
                        })
                        .on('data', function(data) {
                            logger.info(data.toString());
                        }).stderr.on('data', function(data) {
                            logger.error(data.toString());
                        });
                    });
                },

                //install resource keys
                function(next) { 
                    if(!task.resource_deps) return next();
                    async.forEach(task.resource_deps, function(resource, next_dep) {
                        logger.info("storing resource key for "+resource._id+" as requested");
                        common.decrypt_resource(resource);

                        //now handle things according to the resource type
                        switch(resource.type) {
                        case "hpss": 
                            //now install the hpss key
                            var key_filename = ".sca/keys/"+resource._id+".keytab";
                            conn.exec("cat > "+key_filename+" && chmod 600 "+key_filename, function(err, stream) {
                                if(err) return next_dep(err);
                                stream.on('close', function(code, signal) {
                                    if(code) return next_dep("Failed to write keytab");
                                    logger.info("successfully stored keytab for resource:"+resource._id);
                                    next_dep();
                                })
                                .on('data', function(data) {
                                    logger.info(data.toString());
                                }).stderr.on('data', function(data) {
                                    logger.error(data.toString());
                                });
                                var keytab = new Buffer(resource.config.enc_keytab, 'base64');
                                stream.write(keytab);
                                stream.end();
                            });
                            break;
                        default: 
                            next_dep("don't know how to handle resource_deps with type:"+resource.type);
                        }
                    }, next);
                },

                //make sure dep task dirs are synced 
                function(next) {
                    if(!task.deps) return next(); //skip
                    async.forEach(task.deps, function(dep, next_dep) {
                        //if resource is the same, don't need to sync
                        if(task.resource_id.toString() == dep.resource_id.toString()) return next_dep();
                        db.Resource.findById(dep.resource_id, function(err, source_resource) {
                            if(err) return next_dep(err);
                            if(!source_resource) return next_dep("couldn't find dep resource:"+dep.resource_id);
                            var source_path = common.gettaskdir(task.instance_id, dep._id, source_resource);
                            var dest_path = common.gettaskdir(task.instance_id, dep._id, resource);
                            logger.debug("syncing from source:"+source_path+" to dest:"+dest_path);
                            
                            //TODO - how can I prevent 2 different tasks from trying to rsync at the same time?
                            common.progress(task.progress_key+".sync", {status: 'running', progress: 0, weight: 0, name: 'Transferring source task directory'});
                            _transfer.rsync_resource(source_resource, resource, source_path, dest_path, function(err) {
                                if(err) {
                                    common.progress(task.progress_key+".sync", {status: 'failed', msg: err.toString()});
                                    next_dep(err);
                                } else {
                                    common.progress(task.progress_key+".sync", {status: 'finished', msg: "Successfully synced", progress: 1});

                                    //register new resource_id where the task_dir is synced to
                                    if(!~task.resource_ids.indexOf(resource._id)) task.resource_ids.push(resource._id);
                                    task.save(next_dep);
                                }
                            }, function(progress) {
                                common.progress(task.progress_key+".sync", progress);
                            });
                        });
                    }, next);
                },
                
                //install config.json in the taskdir
                function(next) { 
                    if(!task.config) {      
                        logger.info("no config object stored in task.. skipping writing config.json");
                        return next();
                    }
                    //common.progress(task.progress_key+".prep", {status: 'running', progress: 0.6, msg: 'Installing config.json'});
                    logger.debug("installing config.json");
                    logger.debug(task.config);
                    conn.exec("cat > "+taskdir+"/config.json", function(err, stream) {
                        if(err) return next(err);
                        stream.on('close', function(code, signal) {
                            if(code) return next("Failed to write config.json");
                            else next();
                        })
                        .on('data', function(data) {
                            logger.info(data.toString());
                        }).stderr.on('data', function(data) {
                            logger.error(data.toString());
                        });
                        stream.write(JSON.stringify(task.config, null, 4));
                        stream.end();
                    });
                },
               
                //write _status.sh
                function(next) { 
                    //not all service has status
                    if(!service_detail.pkg.scripts.status) return next(); 

                    logger.debug("installing _status.sh");
                    conn.exec("cd "+taskdir+" && cat > _status.sh && chmod +x _status.sh", function(err, stream) {
                        if(err) return next(err);
                        stream.on('close', function(code, signal) {
                            if(code) return next("Failed to write _status.sh -- code:"+code);
                            next();
                        })
                        .on('data', function(data) {
                            logger.info(data.toString());
                        }).stderr.on('data', function(data) {
                            logger.error(data.toString());
                        });
                        stream.write("#!/bin/bash\n");
                        for(var k in envs) {
                            var v = envs[k];
                            var vs = v.replace(/\"/g,'\\"')
                            stream.write("export "+k+"=\""+vs+"\"\n");
                        }
                        stream.write("~/.sca/services/"+service+"/"+service_detail.pkg.scripts.status);
                        stream.end();
                    });
                },
                
                //write _stop.sh
                function(next) { 
                    //not all service has stop
                    if(!service_detail.pkg.scripts.stop) return next(); 

                    logger.debug("installing _stop.sh");
                    conn.exec("cd "+taskdir+" && cat > _stop.sh && chmod +x _stop.sh", function(err, stream) {
                        if(err) return next(err);
                        stream.on('close', function(code, signal) {
                            if(code) return next("Failed to write _stop.sh -- code:"+code);
                            next();
                        })
                        .on('data', function(data) {
                            logger.info(data.toString());
                        }).stderr.on('data', function(data) {
                            logger.error(data.toString());
                        });
                        stream.write("#!/bin/bash\n");
                        for(var k in envs) {
                            var v = envs[k];
                            var vs = v.replace(/\"/g,'\\"')
                            stream.write("export "+k+"=\""+vs+"\"\n");
                        }
                        stream.write("~/.sca/services/"+service+"/"+service_detail.pkg.scripts.stop);
                        stream.end();
                    });
                },
     
                //write _boot.sh
                function(next) { 
                    if(!service_detail.pkg.scripts.run && !service_detail.pkg.scripts.start) {
                        //console.dir(service_detail.pkg.scripts);
                        return next("pkg.scripts.run nor pkg.scripts.start defined in package.json"); 
                    }
                    
                    //common.progress(task.progress_key+".prep", {status: 'running', progress: 0.6, msg: 'Installing config.json'});
                    logger.debug("installing _boot.sh");
                    conn.exec("cd "+taskdir+" && cat > _boot.sh && chmod +x _boot.sh", function(err, stream) {
                        if(err) return next(err);
                        stream.on('close', function(code, signal) {
                            if(code) return next("Failed to write _boot.sh -- code:"+code);
                            next();
                        })
                        .on('data', function(data) {
                            logger.info(data.toString());
                        }).stderr.on('data', function(data) {
                            logger.error(data.toString());
                        });
                        stream.write("#!/bin/bash\n");
                        for(var k in envs) {
                            var v = envs[k];
                            if(v.replace) {
                                var vs = v.replace(/\"/g,'\\"')
                            } else {
                                //probably number
                                var vs = v;
                            }
                            stream.write("export "+k+"=\""+vs+"\"\n");
                        }
                        if(service_detail.pkg.scripts.run) stream.write("~/.sca/services/"+service+"/"+service_detail.pkg.scripts.run+"\n");
                        if(service_detail.pkg.scripts.start) stream.write("~/.sca/services/"+service+"/"+service_detail.pkg.scripts.start+"\n");
                        stream.end();
                    });
                },

                //end of prep
                function(next) {
                    common.progress(task.progress_key+".prep", {status: 'finished', progress: 1, msg: 'Finished preparing for task'}, next);
                },
                
                //finally, start the service
                function(next) {
                    if(!service_detail.pkg.scripts.start) return next(); //not all service uses start

                    logger.debug("starting service: ~/.sca/services/"+service+"/"+service_detail.pkg.scripts.start);
                    common.progress(task.progress_key/*+".service"*/, {/*name: service_detail.label,*/ status: 'running', msg: 'Starting Service'});

                    //conn.exec("cd "+taskdir+" && set -o pipefail && ./_boot.sh 2>&1 | tee start.log", {
                    conn.exec("cd "+taskdir+" && ./_boot.sh > boot.log 2>&1", {
                        /* BigRed2 seems to have AcceptEnv disabled in sshd_config - so I can't pass env via ssh2*/
                    }, function(err, stream) {
                        if(err) return next(err);
                        stream.on('close', function(code, signal) {
                            if(code) {
                                //TODO - I should pull more useful information (from start.log?)
                                return next("failed to start (code:"+code+")");
                            } else {
                                task.status = "running";
                                task.status_msg = "Started service";
                                task.start_date = new Date();
                                task.next_date = new Date(); 
                                task.save(next);
                            }
                        })

                        //NOTE - no stdout / err should be received since it's redirected to boot.log
                        .on('data', function(data) {
                            logger.info(data.toString());
                            //stdout += data;
                        }).stderr.on('data', function(data) {
                            logger.error(data.toString());
                            //stderr += data;
                        });
                    });
                },            
                
                //or run it synchronously (via run.sh)
                function(next) {
                    if(!service_detail.pkg.scripts.run) return next(); //not all service uses run (they may use start/status)

                    logger.debug("running_sync service: ~/.sca/services/"+service+"/"+service_detail.pkg.scripts.run);
                    common.progress(task.progress_key/*+".service"*/, {/*name: service_detail.label,*/ status: 'running', /*progress: 0,*/ msg: 'Running Service'});

                    task.status = "running_sync"; //mainly so that client knows what this task is doing (unnecessary?)
                    task.status_msg = "Running service";
                    task.start_date = new Date();
                    task.save(function() {
                        //conn.exec("cd "+taskdir+" && set -o pipefail && ./_boot.sh 2>&1 | tee run.log", {
                        conn.exec("cd "+taskdir+" && ./_boot.sh > boot.log 2>&1 ", {
                            /* BigRed2 seems to have AcceptEnv disabled in sshd_config - so I can't use env: { SCA_SOMETHING: 'whatever', }*/
                        }, function(err, stream) {
                            if(err) return next(err);
                            //var stdout = "";
                            //var stderr = "";
                            stream.on('close', function(code, signal) {
                                if(code) {
                                    return next("failed to run (code:"+code+")");
                                } else {
                                    load_products(task, taskdir, conn, function(err) {
                                        if(err) return next(err);
                                        common.progress(task.progress_key, {status: 'finished', /*progress: 1,*/ msg: 'Service Completed'});
                                        task.status = "finished"; 
                                        task.status_msg = "Service ran successfully";
                                        task.finish_date = new Date();
                                        task.save(function(err) {
                                            //clear next_date on dependending tasks so that it will be checked immediately
                                            db.Task.update({deps: task._id}, {$unset: {next_date: 1}}, next);
                                        });
                                    });
                                }
                            })
                            
                            //NOTE - no stdout / err should be received since it's redirected to boot.log
                            .on('data', function(data) {
                                logger.info(data.toString());
                                //stdout += data;
                            }).stderr.on('data', function(data) {
                                logger.error(data.toString());
                                //stderr += data;
                            });
                        });
                    });
                },
            ], function(err) {
                cb(err); 
            }); 
        });
    });
}

function load_products(task, taskdir, conn, cb) {
    logger.debug("loading "+taskdir+"/products.json");
    common.progress(task.progress_key, {msg: "Downloading products.json"});
    conn.sftp(function(err, sftp) {
        if(err) return cb(err);
        var stream = sftp.createReadStream(taskdir+"/products.json");
        var products_json = "";
        var error_msg = "";
        stream.on('error', function(err) {
            error_msg = "Failed to download products.json: "+err;
        }); 
        stream.on('data', function(data) {
            products_json += data;
        })
        stream.on('close', function(code, signal) {
            if(code) return cb("Failed to retrieve products.json from the task directory");
            if(error_msg) return cb(error_msg);
            try {
                console.log(products_json);
                task.products = JSON.parse(products_json);
                cb();
            } catch(e) {
                cb("Failed to parse products.json: "+e.toString());
            }
        });
    });
}


