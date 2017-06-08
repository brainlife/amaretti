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

//missing catch() on Promise will be caught here
process.on('unhandledRejection', (reason, promise) => {
    logger.error("sleeping for 10 seconds and killing");
    logger.error(reason);
    setTimeout(function() {
        process.exit(1);
    }, 1000*10);
});

db.init(function(err) {
    if(err) throw err;
    logger.debug("db-initialized");
    //start check loop
    check();
});

//set next_date incrementally longer between each checks (you need to save it persist it)
function set_nextdate(task) {
    var max;
    switch(task.status) {
    case "failed":
    case "finished":
        max = 24*3600*1000; //24 hours
        break;
    default:
        max = 30*60*1000;
    }
    task.next_date = new Date();
    if(task.start_date) {
        var elapsed = new Date() - task.start_date.getTime();
        var delta = elapsed/30;
        var delta = Math.min(delta, max); //limit to max
        var delta = Math.max(delta, 10*1000); //min to 10 seconds
        var next = task.next_date.getTime() + delta;
        task.next_date.setTime(next);
    } else {
        //not yet started. check again in 10 minutes (maybe resource issue?)
        //maybe I should increase the delay to something like an hour?
        task.next_date.setMinutes(task.next_date.getMinutes() + 10);
    }
}

//call this whenever you change task status
function update_instance_status(instance_id, cb) {
    db.Instance.findById(instance_id, function(err, instance) {
        if(err) return cb(err);
        if(!instance) return cb("couldn't find instance by id:"+instance_id);

        //find all tasks under this instance
        db.Task.find({instance_id: instance._id}, 'status status_msg', function(err, tasks) {
            if(err) return cb(err);

            //count status
            let counts = {};
            tasks.forEach(function(task) {
                if(counts[task.status] === undefined) counts[task.status] = 0;
                counts[task.status]++;
            });

            //decide instance status (TODO - I still need to adjust this, I feel)
            let newstatus = "unknown";
            if(tasks.length == 0) newstatus = "empty";
            else if(counts.running > 0) newstatus = "running";
            else if(counts.requested > 0) newstatus = "requested";
            else if(counts.failed > 0) newstatus = "failed";
            else if(counts.finished > 0) newstatus = "finished";
            else if(counts.removed > 0) newstatus = "removed";

            //did status changed?
            if(instance.status != newstatus) {
                logger.debug("instance status changed",instance._id,newstatus);
                if(newstatus == "unknown") logger.debug(counts);
                instance.status = newstatus;
                instance.update_date = new Date();
                instance.save(cb);
            } else cb(); //no change..
        });
    });
}

function check() {
    _status.checks++; //for health reporting
    db.Task.find({
        status: {$ne: "removed"}, //ignore removed tasks
        //status: {$nin: ["removed", "failed"]}, //ignore removed tasks
        $or: [
            {next_date: {$exists: false}},
            {next_date: {$lt: new Date()}}
        ]
    })

    //maybe I should do these later (only needed by requested task)
    //.populate('deps', 'status resource_id')
    .populate('deps')
    .populate('resource_deps')
    .exec((err, tasks) => {
        if(err) throw err; //throw and let pm2 restart
        if(tasks.length) logger.debug("checking tasks:"+tasks.length);
        _status.tasks+=tasks.length; //for health reporting
        async.eachSeries(tasks, (task, next) => {
            logger.info("handling task:"+task._id+" ("+task.name+")"+" "+task.status);
            set_nextdate(task);
            task.save(function() {
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
                /*
                case "failed":
                    //TODO - I don't know what to do for failed tasks yet, but I don't want
                    //to run housekeeping because it sometimes think dependency failed tasks to be removed by cluster.
                    //I want to leave it in failed status)
                    //handle_failed(task, next);
                    next();
                    break;
                case "remove_requested":
                case "finished":
                */
                default:
                    handle_housekeeping(task, next);
                }
            });
        }, function(err) {
            if(err) logger.error(err);

            //wait a bit and recheck again
            setTimeout(check, 500);
        });
    });
}

function handle_housekeeping(task, cb) {
    async.series([
        //check to see if taskdir still exists
        function(next) {
            var missing_resource_ids = [];
            async.forEach(task.resource_ids, function(resource_id, next_resource) {
                db.Resource.findById(resource_id, function(err, resource) {
                    if(err) {
                        logger.error("failed to find resource_id:"+resource_id+" for taskdir check will try later");
                        return next_resource(err);
                    }
                    if(!resource) {
                        logger.info("can't check taskdir for task_id:"+task._id+" because resource_id:"+resource_id+" no longer exist");
                        return next_resource(); //user sometimes removes resource.. but that's ok..
                    }
                    if(!resource.status || resource.status != "ok") {
                        return next_resource("can't check taskdir on resource_id:"+resource._id.toString()+" because resource status is not ok.. will try later");
                    }

                    //all good.. now check taskdir
                    logger.debug("getting ssh connection to check taskdir");
                    common.get_ssh_connection(resource, function(err, conn) {
                        if(err) return next_resource(err);
                        var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
                        if(!taskdir || taskdir.length < 10) return next_resource("taskdir looks odd.. bailing");
                        logger.debug("running ls",taskdir);
                        //TODO is it better to use sftp?
                        conn.exec("ls "+taskdir, function(err, stream) {
                            if(err) return next_resource(err);
                            //timeout in 10 seconds
                            var to = setTimeout(()=>{
                                logger.error("ls timed-out");
                                stream.close();
                                //next_resource();
                            }, 10*1000);
                            stream.on('close', function(code, signal) {
                                if(code == 2) { //ls couldn't find the directory
                                    logger.debug("taskdir:"+taskdir+" is missing");
                                    missing_resource_ids.push(resource_id);
                                }
                                clearTimeout(to);
                                next_resource();
                            })
                            .on('data', function(data) {
                                //logger.debug(data.toString());
                            }).stderr.on('data', function(data) {
                                logger.debug(data.toString());
                            });
                        });
                    });
                });
            }, function(err) {
                if(err) {
                    logger.info(err); //continue
                    next();
                } else {
                    //why I don't clear this? because current task.resource_id
                    //is defined as "resouce id used" (not where it's at currently)
                    //task.resource_id = undefined;

                    //remove missing_resource_ids from resource_ids
                    var resource_ids = [];
                    task.resource_ids.forEach(function(id) {
                        if(!~missing_resource_ids.indexOf(id)) resource_ids.push(id);
                    });
                    task.resource_ids = resource_ids;

                    //now.. if we *know* that there are no resource that has this task, consider it removed
                    if(resource_ids.length == 0) {
                        task.status = "removed"; //most likely removed by cluster
                        task.status_msg = "Output from this task has been removed";
                    }
                    task.save(function(err) {
                        if(err) return next(err);
                        update_instance_status(task.instance_id, next);
                    });
                }
            });
        },

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
            if(task.finish_date && task.finish_date < maxage) {
                logger.info("this task was requested more than 25 days ago..");
                need_remove = true;
            }

            //no need to remove, then no need to go further
            if(!need_remove) return next();

            logger.info("need to remove this task. resource_ids.length:"+task.resource_ids.length);
            var removed_count = 0;
            async.forEach(task.resource_ids, function(resource_id, next_resource) {
                db.Resource.findById(resource_id, function(err, resource) {
                    if(err) {
                        logger.error("failed to find resource_id:"+resource_id+" for removal");
                        return next_resource(err);
                    }
                    if(!resource) {
                        logger.info("can't clean taskdir for task_id:"+task._id+" because resource_id:"+resource_id+" no longer exist");
                        return next_resource(); //user sometimes removes resource.. but that's ok..
                    }
                    if(!resource.status || resource.status != "ok") {
                        return next_resource("can't clean taskdir on resource_id:"+resource._id.toString()+" because resource status is not ok.. will try later");
                    }

                    //all good.. now try to remove taskdir for real
                    common.get_ssh_connection(resource, function(err, conn) {
                        if(err) return next_resource(err);
                        var workdir = common.getworkdir(task.instance_id, resource);
                        var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
                        if(!taskdir || taskdir.length < 10) return next_resource("taskdir looks odd.. bailing");
                        logger.info("removing "+taskdir+" and workdir if empty");
                        conn.exec("rm -rf "+taskdir+" && rmdir --ignore-fail-on-non-empty "+workdir, function(err, stream) {
                            if(err) return next_resource(err);
                            stream.on('close', function(code, signal) {
                                if(code) return next_resource("Failed to remove taskdir "+taskdir);
                                else {
                                    removed_count++;
                                    next_resource();
                                }
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
                    logger.info(err); //continue
                    next();
                } else {
                    //done with removeal
                    task.status = "removed";
                    task.status_msg = "taskdir removed from "+removed_count+" out of "+task.resource_ids.length+" resources";

                    //reset resource ids
                    task.resource_ids = [];

                    task.save(function(err) {
                        if(err) return next(err);
                        update_instance_status(task.instance_id, next);
                    });

                    //also post to progress.. (TODO - should I set the status?)
                    common.progress(task.progress_key, {msg: 'Task directory Removed'});
                }
            });
        },

        //removal of empty instance directory is done by sca-wf-resource service

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
    var failed_deps = [];
    task.deps.forEach(function(dep) {
        if(dep.status != "finished") deps_all_done = false;
        if(dep.status == "failed") failed_deps.push(dep);
    });

    //fail the task if any dependency fails
    //TODO - maybe make this optional based on task option?
    if(failed_deps.length > 0) {
        logger.debug("dependency failed.. failing this task");
        task.status_msg = "Dependency failed.";
        task.status = "failed";
        task.fail_date = new Date();
        task.save(function(err) {
            if(err) return next(err);
            update_instance_status(task.instance_id, next);
        });
        return;
    }

    if(!deps_all_done) {
        logger.debug("dependency not met.. postponing");
        task.status_msg = "Waiting on dependency";
        task.save(next);
        return;
    }

    //logger.debug(JSON.stringify(task, null, 4));

    //need to lookup user's gids to find all resources that user has access to
    logger.debug("looking up user/s gids from auth api");
    request.get({
        url: config.api.auth+"/user/groups/"+task.user_id,
        json: true,
        headers: { 'Authorization': 'Bearer '+config.sca.jwt }
    }, function(err, res, gids) {
        if(err) {
            if(res.statusCode == 404) {
                gids = [];
            } else return next(err);
        }
        switch(res.statusCode) {
        case 404:
            //often user_id is set to non existing user_id on auth service (like "sca")
            gids = []; 
            break;
        case 401:
            //token is misconfigured?
            logger.error("authentication error while obtaining user's group ids");
            logger.error("jwt:"+config.sca.jwt);
            return next(err);
        case 200:
            //success! 
            break;
        default:
            logger.error("invalid status code:"+res.statusCode+" while obtaining user's group ids");
            return next(err);
        }

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
                    task.fail_date = new Date();
                    task.save(function(err) {
                        if(err) logger.error(err);
                        update_instance_status(task.instance_id, err=>{
                            if(err) logger.error(err);
                            //no cb
                        });
                    });
                }
                //start_task is no longer waited by anything.. all task gets processed asyncrhnously
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
        if(!resource) {
            logger.error("can't stop task_id:"+task._id+" because resource_id:"+task.resource_id+" no longer exists");
            task.status = "stopped";
            task.status_msg = "Couldn't stop cleanly. Resource no longer exists.";
            task.save(function(err) {
                if(err) return next(err);
                update_instance_status(task.instance_id, next);
            });
            return;
        }

        //get_service(task.service, function(err, service_detail) {
        _service.loaddetail(task.service, function(err, service_detail) {
            if(err) {
                logger.error("Couldn't find such service:"+task.service);
                return next(); //skip this task
            }
            if(!service_detail.pkg || !service_detail.pkg.scripts || !service_detail.pkg.scripts.stop) {
                logger.error("service:"+task.service+" doesn't have scripts.stop defined.. marking as finished");
                task.status = "stopped";
                task.status_msg = "Stopped by user";
                task.save(function(err) {
                    if(err) return next(err);
                    update_instance_status(task.instance_id, next);
                });
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
                            task.save(function(err) {
                                if(err) return next(err);
                                update_instance_status(task.instance_id, next);
                            });
                            break;
                        default:
                            task.status_msg = "Failed to stop the task cleanly -- code:"+code;
                            task.save(function(err) {
                                if(err) return next(err);
                                update_instance_status(task.instance_id, next);
                            });
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

    if(!task.resource_id) {
        //not yet submitted to any resource .. maybe just got submitted?
        next();
        return;
    }

    //calculate runtime
    var now = new Date();
    var runtime = now - task.start_date;
    if(task.max_runtime && task.max_runtime < runtime) {
        task.status = "stop_requested";
        task.status_msg = "Runtime exceeded stop date. Stopping";
        task.save(function(err) {
            if(err) return next(err);
            update_instance_status(task.instance_id, next);
        });
        return;
    }

    db.Resource.findById(task.resource_id, function(err, resource) {
        if(err) return next(err);
        if(!resource) {
            task.status = "failed";
            task.status_msg = "Lost resource "+task.resource_id;
            task.fail_date = new Date();
            task.save(function(err) {
                if(err) return next(err);
                update_instance_status(task.instance_id, next);
            });
            return;
        }
        if(resource.status != "ok") {
            task.status_msg = "Resource status is not ok.";
            task.save(next);
            return;
        }
        common.get_ssh_connection(resource, function(err, conn) {
            if(err) {
                task.status_msg = err.toString();
                task.save(next);
                return next();
            }
            var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
            //TODO - not all service provides bin.status.. how will this handle that?
            logger.debug("cd "+taskdir+" && ./_status.sh");
            var delimtoken = "=====WORKFLOW====="; //delimite output from .bashrc to _status.sh
            conn.exec("cd "+taskdir+" && echo '"+delimtoken+"' && ./_status.sh", {}, function(err, stream) {
                if(err) return next(err);
                var out = "";
                stream.on('close', function(code, signal) {

                    //remove everything before sca token (to ignore output from .bashrc)
                    var pos = out.indexOf(delimtoken);
                    out = out.substring(pos+delimtoken.length);
                    logger.info(out);

                    switch(code) {
                    case 0: //still running
                        task.status_msg = out; //should I?
                        task.save(next);
                        break;
                    case 1: //finished
                        load_products(task, taskdir, resource, function(err) {
                            if(err) {
                                logger.info("failed to load products");
                                common.progress(task.progress_key, {status: 'failed', msg: err.toString()});
                                task.status = "failed";
                                task.status_msg = err;
                                task.fail_date = new Date();
                                task.save(function(err) {
                                    if(err) return next(err);
                                    update_instance_status(task.instance_id, next);
                                });
                                return;
                            }
                            logger.info("loaded products");
                            common.progress(task.progress_key, {status: 'finished', msg: 'Service Completed'});
                            task.status = "finished";
                            task.status_msg = "Service completed successfully";
                            task.finish_date = new Date();
                            task.save(function(err) {
                                if(err) return next(err);
                                db.Task.update({deps: task._id}, {
                                    //clear next_date on dependending tasks (not this task!) so that it will be handled immediately
                                    $unset: {next_date: 1},

                                    //also.. if deps tasks has failed, set to *requested* again so that it will be re-tried
                                    //this allows task retried to resume the workflow where it fails.
                                    $set: {status: "requested", run: 0},
                                }, {multi: true}, function(err) {
                                    if(err) return next(err);
                                    update_instance_status(task.instance_id, next);
                                });
                            });
                        });
                        break;
                    case 2: //job failed
                        if(task.retry >= task.run) {
                            common.progress(task.progress_key, {status: 'failed', msg: 'Service failed - retrying:'+task.run});
                            task.status = "requested";
                            task.status_msg = out;
                            task.save(function(err) {
                                if(err) return next(err);
                                update_instance_status(task.instance_id, next);
                            });
                        } else {
                            common.progress(task.progress_key, {status: 'failed', msg: 'Service failed'});
                            task.status = "failed";
                            task.status_msg = out;
                            task.fail_date = new Date();
                            task.save(function(err) {
                                if(err) return next(err);
                                update_instance_status(task.instance_id, next);
                            });

                            //TODO I'd like to notify admin, or service author that the service has failed
                            //for that, I need to lookup the instance detail (for like .. workflow name)
                            //and probably the task owner info,
                            //then, I can publish to a dedicated service.error type exchange with all the information
                            //sca-event can be made to allow admin or certain users subscribe to that event and
                            //send email..

                            //or..another way to deal with this is to create another service that generates a report.
                        }

                        break;
                    case 3: //status temporarly unknown
                        logger.error("couldn't determine the job state. could be an issue with status script");
                        next();
                        break;
                    default:
                        //TODO - should I mark it as failed? or.. 3 strikes and out rule?
                        logger.error("unknown return code:"+code+" returned from _status.sh");
                        next();
                    }
                })
                .on('data', function(data) {
                    //logger.info(str);
                    out += data.toString();
                }).stderr.on('data', function(data) {
                    //logger.error(str);
                    out += data.toString();
                });
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

        //get_service(service, function(err, service_detail) {
        _service.loaddetail(service, function(err, service_detail) {
            if(err) return cb(err);
            if(!service_detail) return cb("Couldn't find such service:"+service);
            //logger.debug(service_detail);
            if(!service_detail.pkg || !service_detail.pkg.scripts) return cb("package.scripts not defined");

            logger.debug("service_detail.pkg");
            logger.debug(service_detail.pkg);

            var workdir = common.getworkdir(task.instance_id, resource);
            var taskdir = common.gettaskdir(task.instance_id, task._id, resource);

            //service dir includes branch name (optiona)
            var servicerootdir = "$HOME/.sca/services"; //TODO - make this configurable?
            var servicedir = servicerootdir+"/"+service;
            if(task.service_branch) servicedir += ":"+task.service_branch;

            var envs = {
                //DEPRECATED - use versions below
                SCA_WORKFLOW_ID: task.instance_id.toString(),
                SCA_WORKFLOW_DIR: workdir,
                SCA_TASK_ID: task._id.toString(),
                SCA_TASK_DIR: taskdir,
                SCA_SERVICE: service,
                SCA_SERVICE_DIR: servicedir,
                SCA_PROGRESS_URL: config.progress.api+"/status/"+task.progress_key,

                //WORKFLOW_ID: task.instance_id.toString(),
                INST_DIR: workdir,
                //TASK_ID: task._id.toString(),
                //TASK_DIR: taskdir,
                //SERVICE: service,
                SERVICE_DIR: servicedir, //where the application is installed
                //WORK_DIR: workdir,
                //PROGRESS_URL: config.progress.api+"/status/"+task.progress_key,
            };

            //optional envs
            if(service.service_branch) {
                envs.SCA_SERVICE_BRANCH = service.service_branch; //DEPRECATED
                envs.SERVICE_BRANCH = service.service_branch;
            }

            task._envs = envs;

            //TODO - I am not sure if this is the right precendence ordering..
            //start with any envs from dependent resources
            if(task.resource_deps) task.resource_deps.forEach(function(resource_dep) {
                let resource_detail = config.resources[resource_dep.resource_id];
                if(resource_detail.envs) for(var key in resource_detail.envs) {
                    envs[key] = resource_detail.envs[key];
                }
                if(resource_dep.envs) for(var key in resource_dep.envs) {
                    envs[key] = resource_dep.envs[key];
                }
            });
            //override with resource base envs
            let resource_detail = config.resources[resource.resource_id];
            if(resource_detail.envs) for(var key in resource_detail.envs) {
                envs[key] = resource_detail.envs[key];
            }
            //override with any resource instance envs
            if(resource.envs) for(var key in resource.envs) {
                envs[key] = resource.envs[key];
            }
            //override with any task envs specified by submitter
            if(task.envs) for(var key in task.envs) {
                envs[key] = task.envs[key];
            }

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
                    var cmd = "ls "+servicedir+ " >/dev/null 2>&1 || "; //check to make sure if it's already installed
                    cmd += "(";
                    cmd += "mkdir -p "+servicerootdir+"/"+repo_owner+" && LD_LIBRARY_PATH=\"\" ";
                    cmd += "flock "+servicerootdir+"/flock.clone git clone ";
                    if(task.service_branch) cmd += "-b "+task.service_branch+" ";
                    cmd += service_detail.git.clone_url+" "+servicedir;
                    cmd += ")";
                    logger.debug(cmd);
                    conn.exec(cmd, function(err, stream) {
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
                    var branch = service.service_branch || "master";
                    //https://stackoverflow.com/questions/1125968/how-do-i-force-git-pull-to-overwrite-local-files
                    //-q to prevent git to send log to stderr
                    conn.exec("flock "+servicerootdir+"/flock.pull sh -c 'cd "+servicedir+" && git fetch && git reset -q --hard origin/"+branch+"'", function(err, stream) {
                        if(err) return next(err);
                        stream.on('close', function(code, signal) {
                            if(code) return next("Failed to git pull in "+servicedir);
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
                            //var source_path = common.gettaskdir(task.instance_id, dep._id, source_resource);
                            //var dest_path = common.gettaskdir(task.instance_id, dep._id, resource);
                            var source_path = common.gettaskdir(dep.instance_id, dep._id, source_resource);
                            var dest_path = common.gettaskdir(dep.instance_id, dep._id, resource);
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
                        //console.dir(envs);
                        for(var k in envs) {
                            var v = envs[k];
                            if(typeof v !== 'string') {
                                logger.warn("skipping non string value:"+v+" for key:"+k);
                                continue;
                            }
                            var vs = v.replace(/\"/g,'\\"')
                            stream.write("export "+k+"=\""+vs+"\"\n");
                        }
                        //stream.write(servicedir+"/"+service_detail.pkg.scripts.status);
                        stream.write("$SERVICE_DIR/"+service_detail.pkg.scripts.status);
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
                        //stream.write(servicedir+"/"+service_detail.pkg.scripts.stop);
                        stream.write("$SERVICE_DIR/"+service_detail.pkg.scripts.stop);
                        stream.end();
                    });
                },

                //write _boot.sh
                function(next) {
                    if(!service_detail.pkg.scripts.run && !service_detail.pkg.scripts.start) {
                        //console.dir(service_detail.pkg.scripts);
                        return next("pkg.scripts.run nor pkg.scripts.start defined in package.json");
                    }

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
                        //if(service_detail.pkg.scripts.run) stream.write(servicedir+"/"+service_detail.pkg.scripts.run+"\n");
                        if(service_detail.pkg.scripts.run) stream.write("$SERVICE_DIR/"+service_detail.pkg.scripts.run+"\n");
                        //if(service_detail.pkg.scripts.start) stream.write(servicedir+"/"+service_detail.pkg.scripts.start+"\n");
                        if(service_detail.pkg.scripts.start) stream.write("$SERVICE_DIR/"+service_detail.pkg.scripts.start+"\n");
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

                    logger.debug("starting service: "+servicedir+"/"+service_detail.pkg.scripts.start);
                    common.progress(task.progress_key, {status: 'running', msg: 'Starting Service'});

                    task.run++;
                    task.status = "running";
                    task.status_msg = "Starting service";
                    task.start_date = new Date();

                    //temporarily set next_date to some impossible date so that we won't run status.sh prematuely
                    task.next_date = new Date();
                    task.next_date.setDate(task.next_date.getDate() + 30);
                    task.save(function(err) {
                        if(err) return next(err);
                        update_instance_status(task.instance_id, function(err) {
                            if(err) return next(err);
                            conn.exec("cd "+taskdir+" && ./_boot.sh > boot.log 2>&1", {
                                /* BigRed2 seems to have AcceptEnv disabled in sshd_config - so I can't pass env via ssh2*/
                            }, function(err, stream) {
                                if(err) return next(err);
                                stream.on('close', function(code, signal) {
                                    if(code) {
                                        //I should undo the impossible next_date set earlier..
                                        task.next_date = new Date();
                                        //TODO - I should pull more useful information (from start.log?)
                                        return next("failed to start (code:"+code+")");
                                    } else {
                                        //good.. now set the next_date to now so that we will check for its status
                                        task.status_msg = "Service started";
                                        task.next_date = new Date();
                                        task.save(next);
                                    }
                                });

                                //NOTE - no stdout / err should be received since it's redirected to boot.log
                                stream.on('data', function(data) {
                                    logger.info(data.toString());
                                });
                                stream.stderr.on('data', function(data) {
                                    logger.error(data.toString());
                                });
                            });
                        });

                    });
                },

                //TODO - DEPRECATE THIS
                //short sync job can be accomplished by using start.sh to run the (short) process and
                //status.sh checking for its output (or just assume that it worked)
                function(next) {
                    if(!service_detail.pkg.scripts.run) return next(); //not all service uses run (they may use start/status)

                    logger.debug("running_sync service: "+servicedir+"/"+service_detail.pkg.scripts.run);
                    common.progress(task.progress_key, {status: 'running', msg: 'Running Service'});

                    task.run++;
                    task.status = "running_sync"; //mainly so that client knows what this task is doing (unnecessary?)
                    task.status_msg = "Running service";
                    task.start_date = new Date();
                    task.save(function(err) {
                        if(err) return next(err);
                        update_instance_status(task.instance_id, function(err) {
                            if(err) return next(err);
                            conn.exec("cd "+taskdir+" && ./_boot.sh > boot.log 2>&1 ", {
                                /* BigRed2 seems to have AcceptEnv disabled in sshd_config - so I can't use env: { SOMETHING: 'whatever', }*/
                            }, function(err, stream) {
                                if(err) return next(err);
                                stream.on('close', function(code, signal) {
                                    if(code) {
                                        return next("failed to run (code:"+code+")");
                                    } else {
                                        load_products(task, taskdir, resource, function(err) {
                                            if(err) return next(err);
                                            common.progress(task.progress_key, {status: 'finished', /*progress: 1,*/ msg: 'Service Completed'});
                                            task.status = "finished";
                                            task.status_msg = "Service ran successfully";
                                            task.finish_date = new Date();
                                            task.save(function(err) {
                                                if(err) return next(err);
                                                //clear next_date on dependending tasks so that it will be checked immediately
                                                db.Task.update({deps: task._id}, {$unset: {next_date: 1}}, {multi: true}, function(err) {
                                                    if(err) return next(err);
                                                    update_instance_status(task.instance_id, next);
                                                });
                                            });
                                        });
                                    }
                                })

                                //NOTE - no stdout / err should be received since it's redirected to boot.log
                                .on('data', function(data) {
                                    logger.info(data.toString());
                                }).stderr.on('data', function(data) {
                                    logger.error(data.toString());
                                });
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

function load_products(task, taskdir, resource, cb) {
    logger.debug("loading "+taskdir+"/products.json");
    //common.progress(task.progress_key, {msg: "Downloading products.json"});
    common.get_sftp_connection(resource, function(err, sftp) {
        if(err) return cb(err);
        var stream = sftp.createReadStream(taskdir+"/products.json");
        var products_json = "";
        var error_msg = "";
        stream.on('error', function(err) {
            error_msg += err;
        });
        stream.on('data', function(data) {
            products_json += data;
        })
        stream.on('close', function(code, signal) {
            if(code) return cb("Failed to retrieve products.json from the task directory - code:",code);
            if(error_msg) {
                logger.info("Failed to load products.json (continuing)");
                logger.info(error_msg);
                return cb();
            }
            try {
                logger.debug("parsing products");
                logger.debug(products_json);

                task.products = JSON.parse(products_json);
                logger.info("successfully loaded products.json");
                cb();
            } catch(e) {
                logger.error("Failed to parse products.json (continuing): "+e.toString());
                cb();
            }
        });
    });
}

var _status = {
    checks: 0,
    tasks: 0,
    //instances: 0,
}

//report health status to sca-wf
function report_health() {
    _status.ssh = common.report_ssh();
    logger.info("reporting health");
    logger.info(_status);
    var url = "http://"+(config.express.host||"localhost")+":"+config.express.port;
    request.post({url: url+"/health/task", json: _status}, function(err, res, body) {
        if(err) logger.error(err);
        _status.checks = 0;
        _status.tasks = 0;
        //_status.instances = 0;
    });
}
setInterval(report_health, 1000*60*10);
setTimeout(report_health, 1000*60); //report soon after start (so that sca-wf's health will look ok)

