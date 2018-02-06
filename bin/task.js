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
    return setTimeout(function() {
        process.exit(1);
    }, 1000*10);
});

db.init(function(err) {
    if(err) throw err;
    logger.debug("db-initialized");
    check(); //start check loop
    setInterval(run_noop, 1000*30);
});

//https://github.com/soichih/workflow/issues/15
function set_nextdate(task) {
    switch(task.status) {
    case "failed":
    case "finished":
    case "stopped":
        //to see if task_dir still exists
        task.next_date = new Date(Date.now()+1000*3600*24);
        //check sooner if we are past the remove_date (TODO - maybe not necessary now that stop_requested would handle this??)
        //if(task.remove_date && task.remove_date < task.next_date) task.next_date = task.remove_date;
        if(task.remove_date && task.remove_date < task.next_date) task.next_date = new Date(Date.now()+1000*3600*1);
        break;
    case "stop_requested":
    case "requested":
    case "running":
        if(!task.start_date) {
            logger.error("status is set to running but no start_date set.. this shouldn't happen (but it did once) investigate!");
            task.start_date = new Date(); 
        }
        var elapsed = Date.now() - task.start_date.getTime(); 
        var delta = elapsed/20; //back off at 1/20 rate
        var delta = Math.min(delta, 1000*3600); //max 1 hour
        var delta = Math.max(delta, 1000*10); //min 10 seconds
        task.next_date = new Date(Date.now() + delta);
        break;
    case "waiting":
        task.next_date = new Date(Date.now()+1000*3600*24);  //should never have to deal with waiting task by themselves
        break;
    default:
        logger.error("don't know how to calculate next_date for status",task.status," -- setting to 1hour");
        task.next_date = new Date(Date.now()+1000*3600); 
    }
}

function set_conn_timeout(cqueue, stream, time) {
    var timeout = setTimeout(()=>{
        logger.error("reached connection timeout.. closing ssh connection (including other sessions..)");
        //stream.close() won't do anything, so the only option is to close the whole connection :: https://github.com/mscdex/ssh2/issues/339
        cqueue.connection.end();
    }, time);
    stream.on('close', (code, signal)=>{
        clearTimeout(timeout);
    });
}


//call this whenever you change task status

function check() {
    _counts.checks++; //for health reporting
    var limit = 200;
    
    //if I want to support multiple task handler, I think I can shard task record by user_id mod process count.
    db.Task.find({
        status: {$ne: "removed"}, //ignore removed tasks
        //status: {$nin: ["removed", "failed"]}, //ignore removed tasks
        $or: [
            {next_date: {$exists: false}},
            {next_date: {$lt: new Date()}}
        ]
    })
    .sort('nice') //handle nice ones later
    .limit(limit) //to avoid overwhelmed..

    //maybe I should do these later (only needed by requested task)
    //.populate('deps', 'status resource_id')
    .populate('deps')
    .populate('resource_deps')
    .exec((err, tasks) => {
        if(err) throw err; //throw and let pm2 restart
        //logger.debug("processing", tasks.length, "tasks");
        if(tasks.length == limit) logger.error("too many tasks to handle... maybe we need to increase capacity, or adjust next_date logic?");

        //save next dates to prevent reprocessing too soon
        async.eachSeries(tasks, (task, next)=>{
            set_nextdate(task);
            task.save(next);
        }, err=>{
            if(err) logger.error("failed to update next_date", err); //continue

            //then start processing each tasks
            var task_count = 0;
            async.eachSeries(tasks, (task, next_task)=>{
                task_count++;
                _counts.tasks++;
                logger.debug("task ("+task_count+"/"+tasks.length+"):"+task._id.toString()+" "+task.service+"("+task.name+")"+" "+task.status);

                //pick which handler to use based on task status
                let handler = null;
                switch(task.status) {
                case "stop_requested": 
                    handler = handle_stop; 
                    break;
                case "requested": 
                    handler = handle_requested; 
                    break;
                case "running": 
                    handler = handle_running; 
                    break;
                case "finished":
                case "failed":
                case "stopped":
                    handler = handle_housekeeping;
                    break;
                }

                if(!handler) {
                    logger.debug("don't have anything particular to do with this task");
                    return next_task(); 
                }

                let previous_status = task.status;
                
                let handler_returned = false;
                handler(task, err=>{
                    if(err) logger.error(err); //continue

                    if(handler_returned) {
                        //TODO we need to figure why why this happens!
                        logger.error("handler already returned", task._id.toString(), previous_status, task.status);
                        return;
                    }
                    handler_returned = true;

                    //store task one last time
                    task.save(function(err) {
                        if(err) logger.error(err); //continue..

                        //if task status changed, update instance status also
                        if(task.status == previous_status) return next_task(); //no change
                        common.update_instance_status(task.instance_id, err=>{
                            if(err) logger.error(err);
                            next_task();
                        });
                    });
                });
            }, ()=>{
                //wait a bit and recheck again
                return setTimeout(check, 500);
            });
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
        next=>{
            //for now, let's only do this check if finish_date or fail_date is sufficiently old
            var minage = new Date();
            minage.setDate(minage.getDate() - 10); 
            var check_date = task.finish_date || task.fail_date;
            if(!check_date || check_date > minage) {
                //logger.info("skipping missing task dir check - as this task is too fresh");
                return next();
            }

            var missing_resource_ids = [];
            //handling all resources in parallel - in a hope to speed things a bit.
            async.each(task.resource_ids, function(resource_id, next_resource) {
                db.Resource.findById(resource_id, function(err, resource) {
                    if(err) {
                        logger.error("failed to find resource_id:"+resource_id.toString()+" for taskdir check will try later");
                        return next_resource(err);
                    }
                    if(!resource || resource.status == 'removed') {
                        logger.info("can't check taskdir for task_id:"+task._id.toString()+" because resource_id:"+resource_id.toString()+" is removed.. assuming task dir to be gone");
                        
                        missing_resource_ids.push(resource_id);
                        return next_resource();
                    }
                    if(!resource.status || resource.status != "ok") {
                        return next_resource("can't check taskdir on resource_id:"+resource._id.toString()+" because resource status is not ok.. will try later");
                    }

                    //all good.. now check taskdir
                    //logger.debug("getting ssh connection for house keeping");
                    common.get_ssh_connection(resource, function(err, conn) {
                        if(err) {
                            logger.error(err);
                            return next_resource(); //maybe a temp. resource error?
                        }
                        var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
                        if(!taskdir || taskdir.length < 10) return next_resource("taskdir looks odd.. bailing");
                        //TODO is it better to use sftp?
                        conn.exec("ls "+taskdir, function(err, stream) {
                            if(err) return next_resource(err);
                            set_conn_timeout(conn, stream, 1000*10);
                            stream.on('close', function(code, signal) {
                                if(code === undefined) {
                                    logger.error("timed out while trying to ls", taskdir, "assuming it still exists");
                                } else if(code == 2) { //ls couldn't find the directory
                                    //CAUTION - I am not entire suer if code 2 means directory is indeed removed, or temporarly went missing (which happens a lot with dc2)
                                    logger.debug("taskdir:"+taskdir+" is missing");
                                    missing_resource_ids.push(resource_id);
                                }
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
                        common.update_instance_status(task.instance_id, next);
                    });
                }
            });
        },

        //remove task dir?
        next=>{
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
                    if(!resource || resource.status == "removed") {
                        logger.info("can't clean taskdir for task_id:"+task._id.toString()+" because resource_id:"+resource_id+" no longer exist");
                        return next_resource(); //user sometimes removes resource.. but that's ok..
                    }
                    if(!resource.status || resource.status != "ok") {
                        return next_resource("can't clean taskdir on resource_id:"+resource._id.toString()+" because resource status is not ok.. will try later");
                    }

                    logger.debug("getting ssh connection to remove work/task dir");
                    common.get_ssh_connection(resource, function(err, conn) {
                        if(err) return next_resource(err);
                        var workdir = common.getworkdir(task.instance_id, resource);
                        var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
                        if(!taskdir || taskdir.length < 10) return next_resource("taskdir looks odd.. bailing");
                        logger.info("removing "+taskdir+" and workdir if empty");
                        conn.exec("rm -rf "+taskdir+" && ([ ! -d "+workdir+" ] || rmdir --ignore-fail-on-non-empty "+workdir+")", function(err, stream) {
                            if(err) return next_resource(err);
                            set_conn_timeout(conn, stream, 1000*60);
                            stream.on('close', function(code, signal) {
                                if(code === undefined) {
                                    next_resource("timeout while removing .. retry later");
                                } else if(code) {
                                    logger.error("Failed to remove taskdir "+taskdir+" code:"+code+" (filesystem issue?)");
                                    //TODO should I retry later?
                                    return next_resource();
                                } else {
                                    logger.debug("successfully removed!");
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
                    logger.debug("done removing");
                    task.status = "removed";
                    task.status_msg = "taskdir removed from "
                    if(removed_count == 0 || removed_count != task.resource_ids.length) {
                        task.status_msg += removed_count+" out of "+task.resource_ids.length+" resources";
                    } else {
                        task.status_msg += " all resources";
                    }

                    //reset resource ids
                    task.resource_ids = [];

                    //also post to progress.. (TODO - should I set the status?)
                    //common.progress(task.progress_key, {msg: 'Task directory Removed'});

                    next();
                }
            });
        },

        //TODO - stop tasks that got stuck in running / running_sync

    ], cb);
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
        return next();
    }

    if(!deps_all_done) {
        logger.debug("dependency not met.. postponing");
        task.status_msg = "Waiting on dependencies";
        task.status = "waiting";
        return next();
    }

    //need to lookup user's gids to find all resources that user has access to
    common.get_gids(task.user_id, (err, gids)=>{
        if(err) return next(err);
        var user = {
            sub: task.user_id,
            gids,
        }
        _resource_select(user, task, function(err, resource, score, considered) {
            if(err) return next(err);
            if(!resource || resource.status == "removed") {
                task.status_msg = "No resource currently available to run this task.. waiting.. ";
                //check again in 5 minutes (too soon?)
                //TODO - I should do exponential back off.. or better yet
                task.next_date = new Date(Date.now()+1000*60*5); 
                return next();
            }
            task.status_msg = "Starting task";
            task.start_date = new Date();
            task._considered = considered;
            task.resource_id = resource._id;
            if(!~common.indexOfObjectId(task.resource_ids, resource._id)) {
                logger.debug("adding resource id", task.service, task._id.toString(), resource._id.toString());
                task.resource_ids.push(resource._id);
            }

            common.progress(task.progress_key, {status: 'running', progress: 0, msg: 'Initializing'});
            start_task(task, resource, function(err) {
                if(err) {
                    //failed to start (or running_sync failed).. mark the task as failed
                    common.progress(task.progress_key, {status: 'failed', msg: err.toString()});
                    logger.error(task._id.toString(), err);
                    task.status = "failed";
                    task.status_msg = err;
                    task.fail_date = new Date();
                } 
                task.save();
            });

            //don't wait for start_task to finish.. move on to the next task
            next();
        });
    });
}

function handle_stop(task, next) {
    logger.info("handling stop request",task._id.toString());

    //if not yet submitted to any resource, then it's easy
    if(!task.resource_id) {
        task.status = "removed";
        task.status_msg = "Removed before ran on any resource";
        return next();
    }

    db.Resource.findById(task.resource_id, function(err, resource) {
        if(err) return next(err);
        if(!resource || resource.status == "removed") {
            logger.error("can't stop task_id:"+task._id.toString()+" because resource_id:"+task.resource_id+" no longer exists");
            task.status = "stopped";
            task.status_msg = "Couldn't stop cleanly. Resource no longer exists.";
            return next();
        }
        if(!resource.status || resource.status != "ok") {
            task.status_msg = "Resource status is not ok .. postponing stop";
            return next();
        }

        _service.loaddetail(task.service, task.service_branch, function(err, service_detail) {
            if(err) return next(err);

            logger.debug("getting ssh connection to stop task");
            common.get_ssh_connection(resource, function(err, conn) {
                if(err) return next(err);
                var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
                conn.exec("cd "+taskdir+" && source _env.sh && "+service_detail.stop, (err, stream)=>{
                    if(err) return next(err);
                    set_conn_timeout(conn, stream, 1000*60);
                    stream.on('close', function(code, signal) {
                        logger.debug("stream closed "+code);
                        task.status = "stopped";
                        if(code === undefined) {
                            task.status_msg = "Timedout while trying to stop the task";
                        } else if(code) {
                            task.status_msg = "Failed to stop the task cleanly -- code:"+code;
                        } else {
                            task.status_msg = "Cleanly stopped by user";
                            //if we were able to stop it, then rehandle the task immediately so that we can remove it if needed (delete api stops task before removing it)
                            if(task.remove_date && task.remove_date < task.next_date) {
                                task.next_date = task.remove_date;
                            }
                        }
                        next();
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

    if(!task.resource_id) {
        //not yet submitted to any resource .. maybe just got submitted?
        return next();
    }

    //calculate runtime
    var now = new Date();
    var runtime = now - task.start_date;
    if(task.max_runtime && task.max_runtime < runtime) {
        task.status = "stop_requested";
        task.status_msg = "Runtime exceeded stop date. Stopping";
        return next();
    }

    db.Resource.findById(task.resource_id, function(err, resource) {
        if(err) return next(err);
        if(!resource || resource.status == "removed") {
            task.status = "failed";
            task.status_msg = "Lost resource "+task.resource_id;
            task.fail_date = new Date();
            return next();
        }
        if(!resource.status || resource.status != "ok") {
            task.status_msg = "Resource status is not ok.";
            return next();
        }

        _service.loaddetail_cached(task.service, task.service_branch, function(err, service_detail) {
            if(err) {
                logger.error("Couldn't load package detail for service:"+task.service);
                return next(err); 
            }

            logger.debug("getting ssh connection to check status");
            common.get_ssh_connection(resource, function(err, conn) {
                if(err) {
                    //retry laster..
                    task.status_msg = err.toString();
                    return next();
                }
                var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
                
                //delimite output from .bashrc to _status.sh so that I can grab a clean status.sh output
                var delimtoken = "=====WORKFLOW====="; 
                logger.debug("running", service_detail.status, task._id.toString(), taskdir)
                conn.exec("cd "+taskdir+" && source _env.sh && echo '"+delimtoken+"' && "+service_detail.status, (err, stream)=>{
                    if(err) return next(err);
                    set_conn_timeout(conn, stream, 1000*15);
                    var out = "";
                    stream.on('close', function(code, signal) {
                        //remove everything before sca token (to ignore output from .bashrc)
                        var pos = out.indexOf(delimtoken);
                        out = out.substring(pos+delimtoken.length).trim();
                        logger.debug(out);

                        switch(code) {
                        case undefined:
                            task.stauts_msg = "status unknown (timeout)"; //assume it to be still running..
                            next();
                            break;
                        case 0: //still running
                            task.status_msg = out; //should I?
                            next();
                            break;
                        case 1: //finished
                            //I am not sure if I have enough usecases to warrent the automatical retrieval of product.json to task..
                            load_product(taskdir, resource, function(err, product) {
                                if(err) {
                                    logger.info("failed to load product");
                                    common.progress(task.progress_key, {status: 'failed', msg: err.toString()});
                                    task.status = "failed";
                                    task.status_msg = err;
                                    task.fail_date = new Date();
                                    next();
                                } else {
                                    logger.info("loaded product.json");
                                    common.progress(task.progress_key, {status: 'finished', msg: 'Service Completed'});
                                    task.status = "finished";
                                    task.status_msg = "Service completed successfully";
                                    task.product = product;
                                    task.finish_date = new Date();
                                    rerun_child(task, next);
                                }
                            });
                            break;
                        case 2: //job failed
                            if(task.retry >= task.run) {
                                common.progress(task.progress_key, {status: 'failed', msg: 'Service failed - retrying:'+task.run});
                                task.status = "requested";
                                task.start_date = undefined;
                                task.status_msg = out;
                            } else {
                                common.progress(task.progress_key, {status: 'failed', msg: 'Service failed'});
                                task.status = "failed";
                                task.status_msg = out;
                                task.fail_date = new Date();
                            }
                            next();
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
                        out += data.toString();
                    }).stderr.on('data', function(data) {
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
        }, cb);
    });
}

//initialize task and run or start the service
function start_task(task, resource, cb) {
    logger.debug("getting ssh connection to start task");
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

            var workdir = common.getworkdir(task.instance_id, resource);
            var taskdir = common.gettaskdir(task.instance_id, task._id, resource);

            var envs = {
                //SERVICE_DIR: taskdir, //deprecated
                SERVICE_DIR: ".", //deprecated
                
                //useful to construct job name?
                TASK_ID: task._id.toString(),
                USER_ID: task.user_id,
                SERVICE: task.service,

                //not really used much (yet?)
                PROGRESS_URL: config.progress.api+"/status/"+task.progress_key,
            };
            task._envs = envs;

            if(task.service_branch) envs.SERVICE_BRANCH = task.service_branch;

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
                   
                //(for backward compatibility) remove old taskdir if it doesn't have .git
                //TODO - get rid of this once we no longer have old tasks
                next=>{
                    conn.exec("[ -d "+taskdir+" ] && [ ! -d "+taskdir+"/.git ] && rm -rf "+taskdir, function(err, stream) {
                        if(err) return next(err);
                        set_conn_timeout(conn, stream, 1000*5);
                        stream.on('close', function(code, signal) {
                            if(code === undefined) return next("timeout while cleaning old service dir");
                            else if(code && code == 1) return next(); //taskdir not there (good..)
                            else if(code) return next("Failed to remove old taskdir:"+taskdir+" code:"+code);
                            else next();
                        })
                        .on('data', function(data) {
                            logger.info(data.toString());
                        }).stderr.on('data', function(data) {
                            logger.error(data.toString());
                        });
                    });
                },
                
                //create task dir by git shallow cloning the requested service
                next=>{
                    //logger.debug("git cloning taskdir", task._id.toString());
                    common.progress(task.progress_key+".prep", {progress: 0.5, msg: 'Installing/updating '+service+' service'});
                    var repo_owner = service.split("/")[0];
                    var cmd = "[ -d "+taskdir+" ] || "; //don't need to git clone if the taskdir already exists
                    cmd += "git clone --depth=1 ";
                    if(task.service_branch) cmd += "-b "+task.service_branch+" ";
                    cmd += service_detail.git.clone_url+" "+taskdir;
                    conn.exec(cmd, function(err, stream) {
                        if(err) return next(err);
                        set_conn_timeout(conn, stream, 1000*15);
                        stream.on('close', function(code, signal) {
                            if(code === undefined) return next("timeout while git cloning");
                            else if(code) return next("Failed to git clone. code:"+code);
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
                next=>{
                    //logger.debug("making sure requested service is up-to-date", task._id.toString());
                    conn.exec("cd "+taskdir+" && git fetch && git reset --hard && git pull", function(err, stream) {
                        if(err) return next(err);
                        set_conn_timeout(conn, stream, 1000*15);
                        stream.on('close', function(code, signal) {
                            if(code === undefined) return next("timeout while git pull");
                            else if(code) return next("Failed to git pull "+task._id.toString());
                            else next();
                        })
                        .on('data', function(data) {
                            logger.info(data.toString());
                        }).stderr.on('data', function(data) {
                            logger.error(data.toString());
                        });
                    });
                },                
                
                //install config.json in the taskdir
                next=>{
                    if(!task.config) {
                        logger.info("no config object stored in task.. skipping writing config.json");
                        return next();
                    }

                    logger.debug("installing config.json", task._id.toString());
                    conn.exec("cat > "+taskdir+"/config.json", function(err, stream) {
                        if(err) return next(err);
                        set_conn_timeout(conn, stream, 1000*5);
                        stream.on('close', function(code, signal) {
                            if(code === undefined) return next("timedout while installing config.json");
                            else if(code) return next("Failed to write config.json");
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
                    logger.debug("writing _env.sh", task._id.toString());
                    conn.exec("cd "+taskdir+" && cat > _env.sh && chmod +x _env.sh", function(err, stream) {
                        if(err) return next(err);
                        set_conn_timeout(conn, stream, 1000*5);
                        stream.on('close', function(code, signal) {
                            if(code === undefined) return next("timedout while writing _env.sh");
                            else if(code) return next("Failed to write _env.sh -- code:"+code);
                            else next();
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
                        stream.write("# resource       : "+resource_detail.name+" / "+resource.name+"\n");
                        stream.write("# resource       : "+resource.name+" ("+resource_detail.name+")\n");
                        stream.write("#                : "+username+"@"+hostname+"\n");
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

                        //add PWD to PATH (mainly for custom brainlife hooks provided by the app..)
                        //it might be also handy to run app installed executable, but maybe it will do more harm than good?
                        //if we get rid of this, I need to have all apps register hooks like "start": "./start.sh". instead of just "start.sh"
                        stream.write("export PATH=$PATH:$PWD\n");
                        
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

                //make sure dep task dirs are synced
                next=>{
                    if(!task.deps) return next(); //no deps then skip
                    async.eachSeries(task.deps, function(dep, next_dep) {
                        
                        //if resource is the same, don't need to sync
                        if(task.resource_id.toString() == dep.resource_id.toString()) return next_dep();

                        db.Resource.findById(dep.resource_id, function(err, source_resource) {
                            if(err) return next_dep(err);
                            if(!source_resource) return next_dep("couldn't find dep resource:"+dep.resource_id);
                            var source_path = common.gettaskdir(dep.instance_id, dep._id, source_resource);
                            var dest_path = common.gettaskdir(dep.instance_id, dep._id, resource);
                            //logger.debug("syncing from source:"+source_path+" to dest:"+dest_path);

                            //common.progress(task.progress_key+".sync", {status: 'running', progress: 0, weight: 0, name: 'Transferring source task directory'});
                            task.status_msg = "Synchronizing dependent task directory: "+(dep.desc||dep.name||dep._id.toString());
                            task.save(err=>{
                                //logger.debug("running rsync_resource.............", dep._id.toString());
                                _transfer.rsync_resource(source_resource, resource, source_path, dest_path, err=>{
                                    if(err) {
                                        logger.error("failed rsyncing.........", err, dep._id.toString());
                                        //common.progress(task.progress_key+".sync", {status: 'failed', msg: err.toString()});
                                        
                                        //I want to retry if rsyncing fails by leaving the task status to be requested
                                        //next_dep(err)
                                        task.start_date = undefined; //need to release this so that resource.select will calculate resource availability correctly
                                        task.status_msg = "Failed to synchronize dependent task directories.. will retry later -- "+err.toString();
                                        cb(); //abort the rest of the process
                                    } else {
                                        logger.debug("succeeded rsyncing.........", dep._id.toString());
                                        //common.progress(task.progress_key+".sync", {status: 'finished', msg: "Successfully synced", progress: 1});
                                        //need to add dest resource to source dep
                                        if(!~common.indexOfObjectId(dep.resource_ids, resource._id)) {
                                            logger.debug("adding new resource_id", resource._id);
                                            dep.resource_ids.push(resource._id.toString());
                                            dep.save(next_dep);
                                        } else next_dep();
                                    }
                                });
                            });
                        });
                    }, next);
                },

                //finally, run the service!
                next=>{
                    if(service_detail.run) return next(); //some app uses run instead of start .. run takes precedence

                    logger.debug("starting service: "+taskdir+"/"+service_detail.start);
                    common.progress(task.progress_key, {status: 'running', msg: 'Starting Service'});

                    task.run++;
                    task.status = "running";
                    task.status_msg = "Starting service";
                    task.save(function(err) {
                        if(err) return next(err);
                        common.update_instance_status(task.instance_id, err=>{
                            if(err) return next(err);

                            //BigRed2 seems to have AcceptEnv disabled in sshd_config - so I can't pass env via exec
                            conn.exec("cd "+taskdir+" && source _env.sh && "+service_detail.start+" >> start.log 2>&1", (err, stream)=>{
                                if(err) return next(err);
                                set_conn_timeout(conn, stream, 1000*20);
                                stream.on('close', function(code, signal) {
                                    if(code === undefined) return next("timedout while starting task");
                                    else if(code) return next("failed to start (code:"+code+")");
                                    else {
                                        task.next_date = new Date(); //so that we check the status soon
                                        task.status_msg = "Service started";
                                        next();
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

                //TODO - I think I should deprecate this in the future, but it's still used by 
                //          * soichih/sca-service-noop
                //          * brain-life/validator-neuro-track
                //short sync job can be accomplished by using start.sh to run the (less than 30 sec) process and
                //status.sh checking for its output (or just assume that it worked)
                next=>{
                    if(!service_detail.run) return next(); //not all service uses run (they may use start/status)

                    logger.warn("running_sync service (deprecate!): "+taskdir+"/"+service_detail.run);
                    common.progress(task.progress_key, {status: 'running', msg: 'Running Service'});

                    task.run++;
                    task.status = "running_sync"; //mainly so that client knows what this task is doing (unnecessary?)
                    task.status_msg = "Synchronously running service";
                    task.save(function(err) {
                        if(err) return next(err);
                        //not updating instance status - because run should only take very short time
                        //BigRed2 seems to have AcceptEnv disabled in sshd_config - so I can't set env via exec opt
                        conn.exec("cd "+taskdir+" && source _env.sh && "+service_detail.run+" > run.log 2>&1", (err, stream)=>{
                            if(err) return next(err);
                            set_conn_timeout(conn, stream, 1000*20);
                            stream.on('close', function(code, signal) {
                                if(code === undefined) next("timedout while running_sync");
                                else if(code) return next("failed to run (code:"+code+")");
                                else {
                                    load_product(taskdir, resource, function(err, product) {
                                        if(err) return next(err);
                                        common.progress(task.progress_key, {status: 'finished', /*progress: 1,*/ msg: 'Service Completed'});
                                        task.status = "finished";
                                        task.status_msg = "Service ran successfully";
                                        task.finish_date = new Date();
                                        task.product = product;
                                        rerun_child(task, next);
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
                },

                //end of all steps

            ], cb);
        });
    });
}

function load_product(taskdir, resource, cb) {
    logger.debug("loading "+taskdir+"/product.json");
    common.get_sftp_connection(resource, function(err, sftp) {
        if(err) return cb(err);
        var stream = sftp.createReadStream(taskdir+"/product.json");
        var product_json = "";
        var error_msg = "";
        stream.on('error', function(err) {
            error_msg += err;
        });
        stream.on('data', function(data) {
            product_json += data;
        })
        stream.on('close', function(code, signal) {
            if(code) return cb("Failed to retrieve product.json from the task directory - code:",code);
            if(error_msg) {
                logger.info("Failed to load product.json (continuing)");
                logger.info(error_msg);
                return cb();
            }
            try {
                var product = JSON.parse(product_json);
                logger.info("successfully loaded product.json");
                cb(null, product);
            } catch(e) {
                logger.error("Failed to parse product.json (continuing): "+e.toString());
                cb();
            }
        });
    });
}

//counter to keep up with how many checks are performed in the last few minutes
let _counts = {
    checks: 0,
    tasks: 0,
}

let low_check = 0;

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
    if(_counts.checks == 0) {
        report.status = "failed";
        report.messages.push("low check count");
        low_check++;
        if(low_check > 10) {
            logger.error("task check loop seems to be dead.. suiciding");
            process.exit(1);
        }
    } else low_check = 0;

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
                task.start_date = undefined;
                task.save();
            }
        });
    });
}

