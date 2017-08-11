#!/usr/bin/node
'use strict';

//node
const fs = require('fs');
const path = require('path');
const os = require('os');
const request = require('request');
const redis = require('redis');
const winston = require('winston');
const async = require('async');
const Client = require('ssh2').Client;

//mine
const config = require('../config');
const logger = new winston.Logger(config.logger.winston);
const db = require('../api/models');
const common = require('../api/common');
const _resource_select = require('../api/resource').select;
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
    check(); //start check loop
    setInterval(run_noop, 1000*30);
});

//set next_date incrementally longer between each checks (you need to save it persist it)
/*
function set_nextdate(task) {
    var max;
    switch(task.status) {
    case "failed":
    case "finished":
        max = 24*3600*1000; //24 hours
        break;
    default:
        max = 30*60*1000; //30 minutes
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
        //TODO - if rsyncing takes long time, we could risk re-handling already starting task! (let's hope we can get it done in 20 minutes)
        task.next_date.setMinutes(task.next_date.getMinutes() + 20);
    }
}
*/

//https://github.com/soichih/workflow/issues/15
function set_nextdate(task) {
    switch(task.status) {
    case "failed":
    case "finished":
    case "stopped":
        //to see if task_dir still exists
        task.next_date = new Date(Date.now()+1000*3600*24);
        if(task.remove_date && task.remove_date < task.next_date) task.next_date = task.remove_date;
        break;
    case "stop_requested":
    case "requested":
    case "running_sync":
        //in case request handling failed
        task.next_date = new Date(Date.now()+1000*3600); //retry in an hour
        break;
    case "running":
        var elapsed = Date.now() - task.start_date.getTime(); 
        var delta = elapsed/20; //back off at 1/20 rate
        var delta = Math.min(delta, 1000*3600); //max 1 hour
        var delta = Math.max(delta, 1000*10); //min 10 seconds
        task.next_date = new Date(Date.now() + delta);
        break;
    default:
        logger.error("don't know how to calculate next_date for status"+task.status);
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
    _counts.checks++; //for health reporting
    var limit = 200;
    db.Task.find({
        status: {$ne: "removed"}, //ignore removed tasks
        //status: {$nin: ["removed", "failed"]}, //ignore removed tasks
        $or: [
            {next_date: {$exists: false}},
            {next_date: {$lt: new Date()}}
        ]
    })
    //limit so that we aren't overwhelmed..
    .limit(limit)

    //maybe I should do these later (only needed by requested task)
    //.populate('deps', 'status resource_id')
    .populate('deps')
    .populate('resource_deps')
    .exec((err, tasks) => {
        if(err) throw err; //throw and let pm2 restart
        //logger.debug("processing", tasks.length, "tasks");
        if(tasks.length == limit) logger.error("too many tasks to handle... maybe we need to increase capacility, or adjust next_date logic?");
        _counts.tasks+=tasks.length; //for health reporting
        async.eachSeries(tasks, (task, next) => {
            logger.debug("task:"+task._id+" "+task.service+"("+task.name+")"+" "+task.status);
            set_nextdate(task);
            task.save(function() {
                switch(task.status) {
                case "requested":
                    handle_requested(task, err=>{
                        if(err) logger.error(err);
                        next(); //continue processing other tasks
                    });
                    break;
                case "stop_requested":
                    handle_stop(task, err=>{
                        if(err) logger.error(err);
                        next(); //continue processing other tasks
                    });
                    break;
                case "running":
                    handle_running(task, err=>{
                        if(err) logger.error(err);
                        next(); //continue processing other tasks
                    });
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
                    handle_housekeeping(task, err=>{
                        if(err) logger.error(err);
                        next(); //continue processing other tasks
                    });
                }
            });
        }, function(err) {
            if(err) logger.error(err); //should never get called
            //wait a bit and recheck again
            setTimeout(check, 500);
        });
    });
}

function handle_housekeeping(task, cb) {
    async.series([
            
        //check to see if taskdir still exists
        //TODO...
        //taskdir could *appear* to be gone if admin temporarily unmount the file system, or metadata server is slow, etc, etc..
        //I need to be really be sure that the directory is indeed removed before concluding that it is.
        //To do that, we either need to count the number of times it *appears* to be removed, or do something clever.
        //I also don't see much value in detecting if the directory is removed or not.. 
        function(next) {
            //for now, let's only do this check if finish_date or fail_date is sufficiently old
            var minage = new Date();
            minage.setDate(minage.getDate() - 10); 
            var check_date = task.finish_date || task.fail_date;
            if(!check_date || check_date > minage) {
                //logger.info("skipping missing task dir check - as this task is too fresh");
                return next();
            }

            var missing_resource_ids = [];
            async.eachSeries(task.resource_ids, function(resource_id, next_resource) {
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
                        if(err) {
                            logger.error(err);
                            return next_resource(); //maybe a temp. resource error?
                        }
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
                                //CAUTION - I am not entire suer if code 2 means directory is indeed removed, or temporarly went missing (which happens a lot with dc2)
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
                        if(!~common.indexOfObjectId(missing_resource_ids, id)) resource_ids.push(id);
                    });
                    task.resource_ids = resource_ids;

                    //now.. if we *know* that there are no resource that has this task, consider it removed
                    if(resource_ids.length == 0) {
                        task.status = "removed"; //most likely removed by cluster
                        task.status_msg = "Output from this task seems to have been removed";
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
            async.eachSeries(task.resource_ids, function(resource_id, next_resource) {
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
                        conn.exec("rm -rf "+taskdir+" && ([ ! -d "+workdir+" ] || rmdir --ignore-fail-on-non-empty "+workdir+")", function(err, stream) {
                            if(err) return next_resource(err);
                            stream.on('close', function(code, signal) {
                                if(code) return next_resource("Failed to remove taskdir "+taskdir+" code:"+code);
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

        function(next) {
            //TODO - removal of empty instance directory is done by sca-wf-resource service (not true?)
            next();
        },

        function(next) {
            //TODO - stop tasks that got stuck in running / running_sync
            next();
        },

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

    task.status_msg = "Being processed by task handler..";
    task.save(err=>{
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

            var user = {
                sub: task.user_id,
                gids: gids,
            }
            _resource_select(user, task, function(err, resource, score, considered) {
                if(err) return next(err);
                if(!resource) {
                    task.status_msg = "No resource currently available to run this task.. waiting.. ";
                    task.next_date = new Date(Date.now()+1000*60*5); //check again in 5 minutes (too soon?)
                    task.save(next);
                    return;
                }

                logger.debug(JSON.stringify(considered, null, 4));
                task._considered = considered;
                task.resource_id = resource._id;
                task.status_msg = "Starting task";
                if(!~common.indexOfObjectId(task.resource_ids, resource._id)) {
                    logger.debug("adding resource id", task.service, task._id, resource._id.toString());
                    task.resource_ids.push(resource._id);
                }
                task.save(err=>{
                    if(err) return next(err);
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
                        next();
                    });

                    //start_task is no longer waited by anything.. all task gets processed asyncrhnously
                    //don't wait for start_task to end.. start next task concurrently
                    //I also don't update the "requested" status.. once it's taken by tha handler.
                    //this means that, if task start doesn't finish in time (based on next_date) the same task
                    //could get handled twice..
                    //but the flipside of this is that, if something goes wrong during the startup phase, it will 
                    //be *retried*.. I think latter is more common and benefits outweights the risk..?
                });
            });
        });
    });
}

function handle_stop(task, next) {
    logger.info("handling stop request:"+task._id);

    //if not yet submitted to any resource, then it's easy
    if(!task.resource_id) {
        task.status = "removed";
        task.status_msg = "Removed before ran on any resource";
        task.save(function(err) {
            if(err) return next(err);
            update_instance_status(task.instance_id, next);
        });
        return;
    }

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
        _service.loaddetail(task.service, task.service_branch, function(err, service_detail) {
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
                if(err) {
                    logger.error(err);
                    return next(); //handle this later 
                }
                var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
                //conn.exec("cd "+taskdir+" && ./_stop.sh", {}, function(err, stream) {
                conn.exec("cd "+taskdir+" && source _env.sh && $SERVICE_DIR/"+service_detail.pkg.scripts.stop, (err, stream)=>{
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
                        logger.debug("received stderr");
                        logger.error(data.toString());
                    });
                });
            });
        });
    });
}

//check for task status of already running tasks
function handle_running(task, next) {
    //logger.info("check_running "+task._id);

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

        _service.loaddetail_cached(task.service, task.service_branch, function(err, service_detail) {
            if(err) {
                logger.error("Couldn't find such service:"+task.service);
                return next(); //skip this task
            }
            if(!service_detail.pkg || !service_detail.pkg.scripts || !service_detail.pkg.scripts.status) {
                logger.error("service:"+task.service+" doesn't have scripts.status defined.. can't figure out status");
                task.status = "failed";
                task.status_msg = "status hook not defined in package.json";
                task.save(function(err) {
                    if(err) return next(err);
                    update_instance_status(task.instance_id, next);
                });
                return;
            }
            common.get_ssh_connection(resource, function(err, conn) {
                if(err) {
                    //retry laster..
                    task.status_msg = err.toString();
                    task.save(next);
                    return next();
                }
                var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
                
                //delimite output from .bashrc to _status.sh so that I can grab a clean status.sh output
                var delimtoken = "=====WORKFLOW====="; 
                //conn.exec("cd "+taskdir+" && echo '"+delimtoken+"' && ./_status.sh", {}, function(err, stream) {
                conn.exec("cd "+taskdir+" && source _env.sh && echo '"+delimtoken+"' && $SERVICE_DIR/"+service_detail.pkg.scripts.status, (err, stream)=>{
                    if(err) return next(err);
                    //timeout in 15 seconds
                    var timeout = setTimeout(()=>{
                        logger.error("status.sh timed-out");
                        stream.close();
                    }, 15*1000);
                    var out = "";
                    stream.on('close', function(code, signal) {
                        clearTimeout(timeout);

                        //remove everything before sca token (to ignore output from .bashrc)
                        var pos = out.indexOf(delimtoken);
                        out = out.substring(pos+delimtoken.length).trim();
                        logger.info(out);

                        switch(code) {
                        case 0: //still running
                            task.status_msg = out; //should I?
                            task.save(next);
                            break;
                        case 1: //finished
                            //I am not sure if I have enough usecases to warrent the automatical retrieval of products.json to task..
                            load_products(taskdir, resource, function(err, products) {
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
                                } else {
                                    logger.info("loaded products");
                                    common.progress(task.progress_key, {status: 'finished', msg: 'Service Completed'});
                                    task.status = "finished";
                                    task.status_msg = "Service completed successfully";
                                    task.products = products;
                                    task.finish_date = new Date();
                                    task.save(function(err) {
                                        if(err) return next(err);
                                        update_instance_status(task.instance_id, err=>{
                                            if(err) return next(err);
                                            rerun_child(task, next);
                                        });
                                    });
                                }
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
    });
}

function rerun_child(task, cb) {
    //find all child tasks
    db.Task.find({deps: task._id}, function(err, tasks) {
        if(tasks.length) logger.debug("rerunning child tasks", tasks.length);
        //for each child, rerun
        async.eachSeries(tasks, (_task, next_task)=>{
            common.rerun_task(_task, null, next_task);
        }, err=>{
            if(err) return cb(err); 
            update_instance_status(task.instance_id, cb);
        });
    });
}

//initialize task and run or start the service
function start_task(task, resource, cb) {
    common.get_ssh_connection(resource, function(err, conn) {
        if(err) {
            logger.error(err);
            return cb(); //retry later..
        }
        var service = task.service; //TODO - should I get rid of this unwrapping? (just use task.service)
        if(service == null) return cb(new Error("service not set.."));

        logger.debug("loading service detail");
        _service.loaddetail(service, task.service_branch, function(err, service_detail) {
            if(err) return cb(err);
            if(!service_detail) return cb("Couldn't find such service:"+service);
            if(!service_detail.pkg || !service_detail.pkg.scripts) return cb("package.scripts not defined");
            if(!service_detail.pkg.scripts.run && !service_detail.pkg.scripts.start) {
                return cb("no pkg.scripts.run nor pkg.scripts.start defined in package.json");
            }

            //logger.debug("service_detail.pkg");
            //logger.debug(service_detail.pkg);

            var workdir = common.getworkdir(task.instance_id, resource);
            var taskdir = common.gettaskdir(task.instance_id, task._id, resource);

            //service dir includes branch name (optiona)
            var servicerootdir = "$HOME/.sca/services"; //TODO - make this configurable?
            var servicedir = servicerootdir+"/"+service;
            if(task.service_branch) servicedir += ":"+task.service_branch;

            var envs = {
                //DEPRECATED - use versions below
                //SCA_WORKFLOW_ID: task.instance_id.toString(),
                //SCA_WORKFLOW_DIR: workdir,
                //SCA_TASK_ID: task._id.toString(),
                //SCA_TASK_DIR: taskdir,
                //SCA_SERVICE: service,
                //SCA_SERVICE_DIR: servicedir,
                //SCA_PROGRESS_URL: config.progress.api+"/status/"+task.progress_key,

                //WORKFLOW_ID: task.instance_id.toString(),
                //TASK_DIR: taskdir,
                //SERVICE: service,
                //WORK_DIR: workdir,
                SERVICE_DIR: servicedir, //where the application is installed (used often)
                INST_DIR: workdir, //who uses this?
                PROGRESS_URL: config.progress.api+"/status/"+task.progress_key,
            };

            //optional envs
            if(task.service_branch) {
                envs.SERVICE_BRANCH = task.service_branch;
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

            logger.debug("starting task on "+resource.name);
            async.series([
                   
                //make sure various directory exists
                next=>{
                    logger.debug("making sure directories exists");
                    conn.exec("mkdir -p ~/.sca/keys && chmod 700 ~/.sca/keys && mkdir -p ~/.sca/services && mkdir -p "+taskdir, function(err, stream) {
                        if(err) return next(err);
                        stream.on('close', function(code, signal) {
                            if(code) return next("Failed to prep ~/.sca");
                            else next();
                        })
                        .on('data', function(data) {
                            logger.info(data.toString());
                        }).stderr.on('data', function(data) {
                            logger.error(data.toString());
                        });
                    });
                },

                //install service
                function(next) {
                    logger.debug("git cloning");
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

                //update service
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

                //install resource keys
                function(next) {
                    if(!task.resource_deps) return next();
                    async.eachSeries(task.resource_deps, function(resource, next_dep) {
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
                    async.eachSeries(task.deps, function(dep, next_dep) {
                        
                        //if resource is the same, don't need to sync
                        if(task.resource_id.toString() == dep.resource_id.toString()) return next_dep();

                        db.Resource.findById(dep.resource_id, function(err, source_resource) {
                            if(err) return next_dep(err);
                            if(!source_resource) return next_dep("couldn't find dep resource:"+dep.resource_id);
                            var source_path = common.gettaskdir(dep.instance_id, dep._id, source_resource);
                            var dest_path = common.gettaskdir(dep.instance_id, dep._id, resource);
                            logger.debug("syncing from source:"+source_path+" to dest:"+dest_path);

                            //TODO - how can I prevent 2 different tasks from trying to rsync at the same time?
                            common.progress(task.progress_key+".sync", {status: 'running', progress: 0, weight: 0, name: 'Transferring source task directory'});
                            //logger.debug("rsyncing.........", task._id);
                            task.status_msg = "Synchronizing dependent task directory: "+(dep.desc||dep.name||dep._id.toString());
                            task.save(err=>{
                                logger.debug("running rsync_resource.............", dep._id.toString());
                                _transfer.rsync_resource(source_resource, resource, source_path, dest_path, function(err) {
                                    if(err) {
                                        logger.error("failed rsyncing.........", dep._id.toString());
                                        common.progress(task.progress_key+".sync", {status: 'failed', msg: err.toString()});
                                        next_dep(err);
                                    } else {
                                        logger.debug("succeeded rsyncing.........", dep._id.toString());
                                        common.progress(task.progress_key+".sync", {status: 'finished', msg: "Successfully synced", progress: 1});
                                        //need to add dest resource to source dep
                                        if(!~common.indexOfObjectId(dep.resource_ids, resource._id)) {
                                            dep.resource_ids.push(resource._id.toString());
                                            dep.save(next_dep);
                                        } else next_dep();
                                    }
                                }, function(progress) {
                                    common.progress(task.progress_key+".sync", progress);
                                });
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
                    //logger.debug(task.config);

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

                //write _.env.sh
                next=>{
                    conn.exec("cd "+taskdir+" && cat > _env.sh && chmod +x _env.sh", function(err, stream) {
                        if(err) return next(err);
                        stream.on('close', function(code, signal) {
                            if(code) return next("Failed to write _env.sh -- code:"+code);
                            next();
                        })
                        .on('data', function(data) {
                            logger.info(data.toString());
                        }).stderr.on('data', function(data) {
                            logger.error(data.toString());
                        });
                        stream.write("#!/bin/bash\n");

                        //write some debugging info
                        //logger.debug(JSON.stringify(resource_detail, null, 4));
                        stream.write("# task id        : "+task._id.toString()+" (run "+(task.run+1)+" of "+(task.retry+1)+")\n");
                        //stream.write("# resource id    : "+resource._id+"\n");
                        var username = (resource.config.username||resource_detail.username);
                        var hostname = (resource.config.hostname||resource_detail.hostname);
                        //stream.write("# resource       : "+resource.name+" ("+resource_detail.name+")\n");
                        stream.write("# resource       : "+username+"@"+hostname+"\n");
                        stream.write("# task dir       : "+taskdir+"\n");
                        //stream.write("# task deps      : "+task.deps+"\n"); //need to unpopulate
                        if(task.remove_date) stream.write("# remove_date    : "+task.remove_date+"\n");

                        //write ENVs
                        for(var k in envs) {
                            var v = envs[k];
                            if(typeof v !== 'string') {
                                logger.warn("skipping non string value:"+v+" for key:"+k);
                                continue;
                            }
                            var vs = v.replace(/\"/g,'\\"')
                            stream.write("export "+k+"=\""+vs+"\"\n");
                        }
                        
                        //report why the resource was picked
                        stream.write("\n# why was this resource chosen?\n");
                        task._considered.forEach(con=>{
                            stream.write("# "+con.name+" ("+con.id+")\n");
                            con.detail.split("\n").forEach(line=>{
                                stream.write("#    "+line+"\n");
                            });
                        });
                        stream.write("\n");

                        stream.end();
                    });
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

                            //conn.exec("cd "+taskdir+" && ./_boot.sh > boot.log 2>&1", {
                            //BigRed2 seems to have AcceptEnv disabled in sshd_config - so I can't pass env via exec
                            conn.exec("cd "+taskdir+" && source _env.sh && $SERVICE_DIR/"+service_detail.pkg.scripts.start+" > start.log 2>&1", (err, stream)=>{
                                if(err) return next(err);

                                var timeout = setTimeout(()=>{
                                    logger.info("start script didn't complete in 30 seconds .. terminating");
                                    stream.close();
                                }, 1000*30); //30 seconds should be enough to start

                                stream.on('close', function(code, signal) {
                                    clearTimeout(timeout);
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
                //     who uses it?
                //          * soichih/sca-service-noop
                //          * brain-life/validator-neuro-track
                //short sync job can be accomplished by using start.sh to run the (less than 30 sec) process and
                //status.sh checking for its output (or just assume that it worked)
                function(next) {
                    if(!service_detail.pkg.scripts.run) return next(); //not all service uses run (they may use start/status)

                    logger.error("running_sync service (deprecate!): "+servicedir+"/"+service_detail.pkg.scripts.run);
                    common.progress(task.progress_key, {status: 'running', msg: 'Running Service'});

                    task.run++;
                    task.status = "running_sync"; //mainly so that client knows what this task is doing (unnecessary?)
                    task.status_msg = "Running service";
                    task.start_date = new Date();
                    task.save(function(err) {
                        if(err) return next(err);
                        //not updating instance status - because run should only take very short time
                        //update_instance_status(task.instance_id, function(err) {
                        //    if(err) return next(err);
                        //conn.exec("cd "+taskdir+" && ./_boot.sh > boot.log 2>&1 ", {
                        //BigRed2 seems to have AcceptEnv disabled in sshd_config - so I can't set env via exec opt
                        conn.exec("cd "+taskdir+" && source _env.sh && $SERVICE_DIR/"+service_detail.pkg.scripts.run+" > run.log 2>&1", (err, stream)=>{
                            if(err) return next(err);

                            var timeout = setTimeout(()=>{
                                logger.info("run didn't complete in 60 seconds .. terminating");
                                stream.close();
                            }, 1000*60); //60 seconds max for running_sync
                            stream.on('close', function(code, signal) {
                                clearTimeout(timeout);
                                if(code) {
                                    return next("failed to run (code:"+code+")");
                                } else {
                                    load_products(taskdir, resource, function(err, products) {
                                        if(err) return next(err);
                                        common.progress(task.progress_key, {status: 'finished', /*progress: 1,*/ msg: 'Service Completed'});
                                        //logger.debug(JSON.stringify(task, null, 4));

                                        task.status = "finished";
                                        task.status_msg = "Service ran successfully";
                                        task.finish_date = new Date();
                                        task.products = products;
                                        task.save(function(err) {
                                            if(err) return next(err);
                                            update_instance_status(task.instance_id, function(err) {
                                                rerun_child(task, next);
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
                        //});
                    });
                },
            ], function(err) {
                cb(err);
            });
        });
    });
}

function load_products(taskdir, resource, cb) {
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
                //logger.debug("parsing products");
                //logger.debug(products_json);

                var products = JSON.parse(products_json);
                //task.products = products;
                logger.info("successfully loaded products.json");
                cb(null, products);
            } catch(e) {
                logger.error("Failed to parse products.json (continuing): "+e.toString());
                cb();
            }
        });
    });
}

//counter to keep up with how many checks are performed in the last few minutes
var _counts = {
    checks: 0,
    tasks: 0,
}

function health_check() {
    var ssh = common.report_ssh();
    var report = {
        status: "ok",
        ssh,
        messages: [],
        date: new Date(),
        counts: _counts,
        maxage: 1000*60*3,
    }

    if(_counts.tasks == 0) { //should have at least 1 from noop check
        report.status = "failed";
        report.messages.push("low tasks count");
    }
    if(_counts.checks < 5) {
        report.status = "failed";
        report.messages.push("low check count");
    }

    //similar code exists in /api/health.js
    if(ssh.max_channels > 5) {
        report.status = "failed";
        report.messages.push("high ssh channels "+ssh.max_channels);
    }
    if(ssh.ssh_cons > 20) {
        report.status = "failed";
        report.messages.push("high ssh connections "+ssh.ssh_cons);
    }

    //check sshagent
    _transfer.sshagent_list_keys((err, keys)=>{
        if(err) {
            report.status = 'failed';
            report.messages.push(err);
        }
        report.agent_keys = keys.length;
        rcon.set("health.workflow.task."+(process.env.NODE_APP_INSTANCE||'0'), JSON.stringify(report));

        //reset counter
        _counts.checks = 0;
        _counts.tasks = 0;
    });
}

var rcon = redis.createClient(config.redis.port, config.redis.server);
rcon.on('error', err=>{throw err});
rcon.on('ready', ()=>{
    logger.info("connected to redis");
    setInterval(health_check, 1000*60);
});

//run noop periodically to keep task loop occupied
function run_noop() {
    if(_counts.tasks != 0) return; //only run if task loop is bored

    //find instance to run
    db.Instance.findOne({name: "_health"}, (err, instance)=>{
        if(err) return logger.error(err);
        if(!instance) {
            logger.info("need to submit _health instance");
            instance = new db.Instance({
                name: "_health",
            });
            instance.save();
        }
        //console.dir(instance._id.toString());

        //find noop task
        db.Task.findOne({name: "noop", instance_id: instance._id}, (err, task)=>{
            if(err) return logger.error(err);
            if(!task) {
                logger.info("need to submit noop task");
                task = new db.Task({
                    name: "noop",
                    user_id: "1", //picking random user here..
                    instance_id: instance._id,
                    status: "requested",
                    config: { "test": 123 },
                    service: "soichih/sca-service-noop",  
                });
                task.save();
                return;
            }
            //console.dir(JSON.stringify(task, null, 4));

            logger.debug("health: noop status:", task.status, task._id.toString(), task.next_date);
            if(task.status == "failed") {
                logger.error("noop failed");
                logger.error(console.dir(JSON.stringify(task, null, 4)));
                //continue
            }
            if(task.status == "requested") {
                return;
            }
            if(task.status != "running") {
                //if not running, run it again 
                //logger.debug("health/rerunning noop");
                task.status = "requested";
                task.next_date = undefined;
                task.save();
            }
        });
    });
}



