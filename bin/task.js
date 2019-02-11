#!/usr/bin/node

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
const logger = winston.createLogger(config.logger.winston);
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
    //setInterval(run_noop, 1000*30);
});

//https://github.com/soichih/workflow/issues/15
function set_nextdate(task) {
    switch(task.status) {
    case "failed":
    case "finished":
    case "stopped":
        task.next_date = new Date(Date.now()+1000*3600*24);
            
        //check sooner if we are past the remove_date (TODO - maybe not necessary now that stop_requested would handle this??)
        //if(task.remove_date && task.remove_date < task.next_date) task.next_date = new Date(Date.now()+1000*3600*1);
        break;

    case "running":
        if(!task.start_date) logger.error("status is set to running but no start_date set.. this shouldn't happen (but it did once) investigate!");
    case "stop_requested":
        var elapsed = 0;
        if(task.start_date) elapsed = Date.now() - task.start_date.getTime(); 

        var delta = elapsed/20; 
        var delta = Math.min(delta, 1000*3600); //max 1 hour
        var delta = Math.max(delta, 1000*10); //min 10 seconds
        task.next_date = new Date(Date.now() + delta);
        break;

    case "requested":
        task.next_date = new Date(Date.now()+1000*3600); //handle_requested will reset next_date.. this is for retry
        break;

    case "running_sync":
        logger.warn("don't know how to set next_date for running_sync..");
        //TODO - maybe fail the task if it's running too long?
        task.next_date = new Date(Date.now()+1000*3600); 
        break;
    default:
        logger.warn(["don't know how to calculate next_date for status",task.status," -- setting to 1hour"]);
        task.next_date = new Date(Date.now()+1000*3600); 
    }
}

function check(cb) {
    _counts.checks++; //for health reporting
    db.Task.findOne({
        status: {$ne: "removed"}, //ignore removed tasks
        //status: {$nin: ["removed", "failed"]}, //ignore removed tasks
        $or: [
            {next_date: {$exists: false}},
            {next_date: {$lt: new Date()}}
        ]
    })
    .sort('nice next_date') //handle nice ones later, then sort by next_date
    .populate('deps')
    .populate('resource_deps')
    .exec((err, task) => {
        if(err) throw err; //throw and let pm2 restart
        if(!task) {
            logger.debug("nothing to do.. sleeping..");
            return setTimeout(check, 1000); 
        }

        set_nextdate(task);
        _counts.tasks++;
        logger.info("------- %s %s by %s id:%s %s", task.status, task.service, task.user_id, task._id.toString(), task.name);
        
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
t
        /*
        case "finished":
        case "failed":
        case "stopped":
        */
        default:
            handler = handle_housekeeping;
        }

        let previous_status = task.status;
        handler(task, err=>{
            if(err) logger.error(err); //continue
            task.save(function(err) {
                if(err) logger.error(err); //continue..

                //if task status changed, update instance status also
                if(task.status == previous_status) return check(); //no change
                common.update_instance_status(task.instance_id, err=>{
                    if(err) logger.error(err);
                    check();
                });
            });
        });
    });
}

/*
function handle_unknown(task, cb) {
    logger.debug("don't have anything particular to do with this task");
    return cb(); 
}
*/

function handle_housekeeping(task, cb) {
    //logger.debug("houskeeping!");
    async.series([
        //check to see if taskdir still exists
        //TODO...
        //taskdir could *appear* to be gone if admin temporarily unmount the file system, or metadata server is slow, etc, etc..
        //I need to be really be sure that the directory is indeed removed before concluding that it is.
        //To do that, we either need to count the number of times it *appears* to be removed, or do something clever.
        //TODO..
        //I need to sole this.. if task gets removed by resource, we need to mark the task as removed or dependending task
        //will fail! For now, we can make sure that resource won't remove tasks for at least 25 days... Maybe we could make this
        //number configurable for each task?
        next=>{
            //for now, let's only do this check if finish_date or fail_date is sufficiently old
            var minage = new Date();
            minage.setDate(minage.getDate() - 25); 
            var check_date = task.finish_date || task.fail_date;
            if(!check_date || check_date > minage) {
                logger.info("skipping missing task dir check - as this task is too fresh");
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
                    if(!resource.active) return next_resource("resource is inactive.. will try later");
                    if(!resource.status || resource.status != "ok") {
                        return next_resource("can't check taskdir on resource_id:"+resource._id.toString()+" because resource status is not ok.. will try later");
                    }

                    //all good.. now check to see if taskdir still exists (not purged by resource)
                    /*
                    logger.debug("getting ssh connection for house keeping:"+resource_id);
                    common.get_ssh_connection(resource, function(err, conn) {
                        if(err) {
                            logger.error(err);
                            return next_resource(); //maybe a temp. resource error?
                        }
                        var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
                        if(!taskdir || taskdir.length < 10) return next_resource("taskdir looks odd.. bailing");
                        //TODO is it better to use sftp?
                        console.time(taskdir);
                        logger.debug("querying ls %s", taskdir);
                        //conn.exec("timeout 10 ls "+taskdir, function(err, stream) {
                        conn.exec("timeout 10 [ -d "+taskdir+" ]", function(err, stream) {
                            if(err) return next_resource(err);
                            stream.on('close', function(code, signal) {
                                console.log("end--");
                                console.timeEnd(taskdir);
                                if(code === undefined) {
                                    logger.error("timed out while trying to ls "+taskdir+" assuming it still exists");
                                } else if(code == 2) { //ls couldn't find the directory
                                    //CAUTION - I am not entire suer if code 2 means directory is indeed removed, or temporarly went missing (which happens a lot with dc2)
                                    logger.debug("taskdir:"+taskdir+" is missing");
                                    missing_resource_ids.push(resource_id);
                                }
                                logger.debug("exists %s", taskdir);
                                next_resource();
                            })
                            .on('data', function(data) {
                                //logger.debug(data.toString());
                            }).stderr.on('data', function(data) {
                                logger.debug(data.toString());
                            });
                        });
                    });
                    */
                    logger.debug("getting sftp connection for taskdir check:"+resource_id);
                    common.get_sftp_connection(resource, function(err, sftp) {
                        if(err) {
                            logger.error(err);
                            return next_resource(); //maybe a temp. resource error?
                        }
                        var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
                        if(!taskdir || taskdir.length < 10) return next_resource("taskdir looks odd.. bailing");
                        //TODO is it better to use sftp?
                        logger.debug("querying ls %s", taskdir);
                        var t = setTimeout(function() { t = null; }, 5000); 
                        sftp.readdir(taskdir, function(err, files) {
                            if(!t) {
                                logger.error("timed out while trying to ls "+taskdir+" assuming it still exists");
                            } else {
                                clearTimeout(t);
                                if(err) {
                                    //TODO - let's assume directory is missing.. we need to parse the err to see why it failes.
                                    logger.debug(err);
                                    missing_resource_ids.push(resource_id);
                                } else {
                                    //TODO - can I do something useful with files?
                                    logger.debug("taskdir has %d files", files.length);
                                }
                            }
                            next_resource();
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
                    next();
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

            //remove task that's more than 3 months
            var maxage = new Date();
            maxage.setDate(now.getDate() - 90);
            if(task.create_date < maxage) {
                need_remove = true;
            }

            //no need to remove, then no need to go further
            if(!need_remove) return next();

            //find any tasks that depends on me.. 
            db.Task.findOne({ 
                deps: task._id, 
                status: {$in: [ "requested", "running", "running_sync" ]} 
            }, (err, depend)=>{
                if(err) next(err);
                if(depend) {
                    task.status_msg = "Waiting for active deps before removing.. ";
                    return next(); //veto!
                }

                //start removing!
                logger.info("need to remove this task. resource_ids.length:"+task.resource_ids.length);
                let removed_resource_ids = [];
                async.eachSeries(task.resource_ids, function(resource_id, next_resource) {
                    db.Resource.findById(resource_id, function(err, resource) {
                        if(err) {
                            logger.error(["failed to find resource_id:"+resource_id+" for removal.. db issue?", err]);
                            return next_resource();
                        }
                        if(!resource || resource.status == "removed") {
                            //user sometimes removes resource.. but that's ok..
                            logger.info("can't clean taskdir for task_id:"+task._id.toString()+" because resource_id:"+resource_id+" no longer exists in db..");
                            //removed_resource_ids.push(resource_id);
                            return next_resource(); 
                        }
                        if(!resource.active) {
                            logger.info("resource("+resource._id.toString()+") is inactive.. can't remove from this resource");
                            return next_resource();
                        }
                        if(!resource.status || resource.status != "ok") {
                            logger.info("can't clean taskdir on resource_id:"+resource._id.toString()+" because resource status is not ok.. can't remove from this resource");
                            return next_resource();
                        }

                        common.get_ssh_connection(resource, function(err, conn) {
                            if(err) return next_resource(err);
                            var workdir = common.getworkdir(task.instance_id, resource);
                            var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
                            if(!taskdir || taskdir.length < 10) return next_resource("taskdir looks odd.. bailing");
                            //TODO - instead of physically removing task dir, maybe I can mark it, or move it trash/ and let 
                            //each resource take care of the actual removal
                            logger.info("removing "+taskdir+" and workdir if empty");
                            conn.exec("timeout 60 bash -c \"rm -rf "+taskdir+" && ([ ! -d "+workdir+" ] || rmdir --ignore-fail-on-non-empty "+workdir+")\"", function(err, stream) {
                                if(err) return next_resource(err);
                                //common.set_conn_timeout(conn, stream, 1000*60);
                                stream.on('close', function(code, signal) {
                                    if(code === undefined) {
                                        logger.error("timeout while removing taskdir");
                                    } else if(code) {
                                        logger.error("Failed to remove taskdir "+taskdir+" code:"+code+" (filesystem issue?)");
                                    } else {
                                        logger.debug("successfully removed!");
                                        removed_resource_ids.push(resource_id);
                                    }
                                    next_resource();
                                })
                                .on('data', function(data) {
                                    logger.info(data.toString());
                                }).stderr.on('data', function(data) {
                                    logger.info(data.toString());
                                });
                            });
                        });
                    });
                }, function(err) {
                    if(err) {
                        logger.error(err); //continue with other task..
                        next();
                    } else {
                        task.status_msg = "removed "+removed_resource_ids.length+" out of "+task.resource_ids.length+" resources";
                        task.status = "removed";

                        //remove removed resource_ids
                        var resource_ids = [];
                        task.resource_ids.forEach(function(id) {
                            if(!~common.indexOfObjectId(removed_resource_ids, id)) resource_ids.push(id);
                        });
                        task.resource_ids = resource_ids;

                        next();
                    }
                });

            });
        },

        //TODO - stop tasks that got stuck in running / running_sync

    ], cb);
}

function handle_requested(task, next) {

    //make sure dependent tasks has all finished
    var deps_all_done = true;
    var failed_deps = [];
    var removed_deps = [];
    task.deps.forEach(function(dep) {
        if(dep.status != "finished") deps_all_done = false;
        if(dep.status == "failed") failed_deps.push(dep);
        if(dep.status == "removed") removed_deps.push(dep);
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
    
    //fail the task if any dependency is removed
    if(removed_deps.length > 0) {
        logger.debug("dependency removed.. failing this task");
        task.status_msg = "Dependency removed.";
        task.status = "failed";
        task.fail_date = new Date();
        return next();
    }
     
    //fail if requested for too long
    var now = new Date();
    var reqtime = now - (task.request_date||task.create_date); //request_date may not be set for old task
    if(reqtime > 1000 * 3600*24*20) {
        task.status_msg = "Task has been stuck in requested state for >20 days.. failing";
        task.status = "failed";
        task.fail_date = new Date();
        return next();
    }

    if(!deps_all_done) {
        logger.debug("dependency not met.. postponing");
        task.status_msg = "Waiting on dependencies";
        task.next_date = new Date(Date.now()+1000*3600*24); //when dependency finished, it should auto-poke this task. so it's okay for this to be long
        return next();
    }

    /*
    //need to lookup user's gids to find all resources that user has access to
    common.get_gids(task.user_id, (err, gids)=>{
        if(err) return next(err);
        var user = {
            sub: task.user_id,
            gids,
        }
    */
    let user = {
        sub: task.user_id,
        gids: task.gids,
    }
    _resource_select(user, task, function(err, resource, score, considered) {
        if(err) return next(err);
        if(!resource || resource.status == "removed") {
            task.status_msg = "No resource currently available to run this task.. waiting.. ";
            //check again in N minutes where N is determined by the number of tasks the project is running (and requested)
            //this should make sure that no project will consume all available slots simply because the project
            //submits tons of tasks..
            //TODO - another way to do this might be to find the max next_date and add +10 seconds to that?
            db.Task.countDocuments({status: "running",  _group_id: task._group_id}, (err, running_count)=>{
                if(err) return next(err);
                db.Task.countDocuments({status: "requested",  _group_id: task._group_id}, (err, requested_count)=>{
                    if(err) return next(err);
                    let secs = (60*running_count)+Math.min(requested_count, 600);
                    logger.info("%s -- retry in %d secs (running:%d requested:%d)", task.status_msg, secs, running_count, requested_count);
                    task.next_date = new Date(Date.now()+1000*secs);
                    next();
                });
            });
            return;
        }
        
        task.status_msg = "Starting task";
        task.start_date = new Date();
        task._considered = considered;
        task.resource_id = resource._id;
        if(!~common.indexOfObjectId(task.resource_ids, resource._id)) {
            logger.debug(["adding resource id", task.service, task._id.toString(), resource._id.toString()]);
            task.resource_ids.push(resource._id);
        }

        var called = false;
        start_task(task, resource, err=>{
            
            //detect multiple cb calling.. (this hasn't happened lately.. maybe I've finally cured it?)
            if(called) throw new Error("callback called again for start_task");
            called = true;

            if(err) {
                //failed to start (or running_sync failed).. mark the task as failed
                //common.progress(task.progress_key, {status: 'failed', msg: err.toString()});
                logger.error([task._id.toString(), err]);
                task.status = "failed";
                task.status_msg = err;
                task.fail_date = new Date();
            } 
            //next();

            //now that we run start_task asynchrously, I need to take care of updating things
            task.save(err=>{
                if(err) logger.error(err);
                common.update_instance_status(task.instance_id, err=>{
                    if(err) logger.error(err);
                });
            });
        });

        //Don't wait for start_task to finish.. could take a while to start.. (especially rsyncing could take a while).. 
        //start_task is designed to be able to run concurrently..
        next();
    });
}

function handle_stop(task, next) {
    logger.info("handling stop request "+task._id.toString());

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

        //TODO - should I go ahead and try stopping task even if resource status is inactive?
        //to let user manually *drain* tasks?
        //(admin can also set maxtask to 0 ... for now)
        if(!resource.active) {
            task.status_msg = "Resource is inactive .. postponing stop";
            return next();
        }

        if(!resource.status || resource.status != "ok") {
            task.status_msg = "Resource status is not ok .. postponing stop";
            return next();
        }

        _service.loaddetail(task.service, task.service_branch, (err, service_detail)=>{
            if(err) return next(err);
            common.get_ssh_connection(resource, function(err, conn) {
                if(err) return next(err);
                var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
                conn.exec("timeout 60 bash -c \"cd "+taskdir+" && source _env.sh && "+service_detail.stop+"\"", (err, stream)=>{
                    if(err) return next(err);
                    stream.on('close', function(code, signal) {
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
                        logger.info(data.toString());
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
    if(task.max_runtime !== undefined && task.max_runtime < runtime) {
        logger.warn("task running too long.. stopping "+runtime);
        task.status = "stop_requested";
        task.status_msg = "Runtime exceeded stop date. Stopping";
        task.next_date = undefined;
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

        //TODO - should I remove this so that we check running task status
        //even after the resource becomes inactive (to simulate "draining"?)
        //admin can also set max task to 0 for now
        if(!resource.active) {
            task.status_msg = "Resource is inactive .. will check later";
            return next();
        }

        if(!resource.status || resource.status != "ok") {
            task.status_msg = "Resource status is not ok .. will check later";
            return next();
        }
        _service.loaddetail(task.service, task.service_branch, (err, service_detail)=>{
            if(err) {
                logger.error("Couldn't load package detail for service:"+task.service);
                return next(err); 
            }

            common.get_ssh_connection(resource, function(err, conn) {
                if(err) {
                    //retry laster..
                    task.status_msg = err.toString();
                    return next();
                }
                var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
                
                //delimite output from .bashrc to _status.sh so that I can grab a clean status.sh output
                var delimtoken = "=====WORKFLOW====="; 
                logger.debug(["running", service_detail.status, task._id.toString(), taskdir])
                conn.exec("timeout 45 bash -c \"cd "+taskdir+" && source _env.sh && echo '"+delimtoken+"' && "+service_detail.status+"\"", (err, stream)=>{
                    if(err) return next(err);
                    //common.set_conn_timeout(conn, stream, 1000*45);
                    var out = "";
                    stream.on('close', function(code, signal) {
                        //remove everything before sca token (to ignore output from .bashrc)
                        var pos = out.indexOf(delimtoken);
                        out = out.substring(pos+delimtoken.length).trim();
                        logger.debug(out);

                        switch(code) {
                        case undefined:
                            logger.debug("status timeout");
                            task.stauts_msg = "status unknown (timeout)"; //assume it to be still running..
                            next();
                            break;
                        case 0: //still running
                            logger.debug("still running");
                            if(out.length > 300) out = "... "+out.substring(out.length - 300); //grab the last N chars if it's too long
                            if(out.length == 0) out = "(no log output)";
                            task.status_msg = out;
                            next();
                            break;
                        case 1: //finished
                            //I am not sure if I have enough usecases to warrent the automatical retrieval of product.json to task..
                            logger.debug("finished!");
                            load_product(taskdir, resource, function(err, product) {
                                if(err) {
                                    logger.info("failed to load product");
                                    //common.progress(task.progress_key, {status: 'failed', msg: err.toString()});
                                    task.status = "failed";
                                    task.status_msg = err;
                                    task.fail_date = new Date();
                                    next();
                                } else {
                                    logger.info("loaded product.json");
                                    //common.progress(task.progress_key, {status: 'finished', msg: 'Service Completed'});
                                    task.finish_date = new Date();
                                    let runtime = task.finish_date.getTime() - task.start_date.getTime();
                                    task.status = "finished";
                                    task.status_msg = "Successfully completed in "+(runtime/(1000*60)).toFixed(2)+" mins on "+resource.name;
                                    task.product = product;
                                    rerun_child(task, next);
                                }
                            });
                            break;
                        case 2: //job failed
                            logger.debug("job failed");
                            if(task.retry >= task.run) {
                                //common.progress(task.progress_key, {status: 'failed', msg: 'Service failed - retrying:'+task.run});
                                task.status = "requested";
                                task.next_date = undefined; //too soon?
                                task.start_date = undefined;
                                task.request_date = new Date();
                                task.request_count = 0;
                                task.status_msg = out+" - retrying "+task.run;
                            } else {
                                //common.progress(task.progress_key, {status: 'failed', msg: 'Service failed'});
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
        if(tasks.length) logger.debug("rerunning child tasks:"+tasks.length);
        //for each child, rerun
        async.eachSeries(tasks, (_task, next_task)=>{
            common.rerun_task(_task, null, next_task);
        }, cb);
    });
}

//initialize task and run or start the service
function start_task(task, resource, cb) {
    /*
    common.get_ssh_connection(resource, function(err, conn) {
        if(err) {
            logger.error(err);
            return cb(); //retry later..
        }
    */
    var service = task.service; //TODO - should I get rid of this unwrapping? (just use task.service)
    if(service == null) return cb(new Error("service not set.."));
    _service.loaddetail(service, task.service_branch, (err, service_detail)=>{
        if(err) return cb(err);
        if(!service_detail) return cb("Couldn't find such service:"+service);

        //var workdir = common.getworkdir(task.instance_id, resource);
        var taskdir = common.gettaskdir(task.instance_id, task._id, resource);

        var envs = {
            SERVICE_DIR: ".", //deprecate! (there are some apps still using this..)
            
            //useful to construct job name?
            TASK_ID: task._id.toString(),
            USER_ID: task.user_id,
            SERVICE: task.service,

            //PROGRESS_URL: config.progress.api+"/status/"+task.progress_key, //deprecated
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
        /*
        //override with any task envs specified by submitter (that a security risk!)
        if(task.envs) for(var key in task.envs) {
            envs[key] = task.envs[key];
        }
        */

        logger.debug("starting task on "+resource.name);
        async.series([
            
            //query current github commit id
            next=>{
                _service.get_sha(service, task.service_branch, (err, ref)=>{
                    if(err) {
                        logger.error("failed to obtain commit id from github.. maybe service/branch no longer exists?");
                        //return next(err); //can't convert to string?
                        return next("failed to get commit id from github");
                    }
                    //console.log(ref.sha);
                    task.commit_id = ref.sha;
                    next();
                });
            },

            /*
            //setup taskdir using app cache
            next=>{
                let workdir = common.getworkdir(null, resource);
                cache_app(conn, service, workdir, taskdir, task.commit_id, (err, app_cache)=>{
                    if(err) return next(err);
                    if(!app_cache) cb(); //cache already inprogress.. retry later..
                    
                    //TODO - this doesn't copy hidden files (like .gitignore).. it's okay?
                    //TODO - should I use rsync instead?
                    conn.exec("mkdir -p "+taskdir+" && cp -r "+app_cache+"/* "+taskdir, (err, stream)=>{
                        if(err) return next(err);
                        stream.on('close', (code, signal)=>{
                            if(code === undefined) return next("timeout while creating taskdir");
                            if(code != 0) return next("failed to create taskdir")
                            logger.debug("taskdir created");
                            next();
                        })
                        .on('data', function(data) {
                            logger.info(data.toString());
                        });
                    });

                });
            },
            */
            
            /* (old way) git clone on remote resource directly.. this requires remote resource to have git installed
             * and also can --egress from the login node*/
            //create task dir by git shallow cloning the requested service
            next=>{
                logger.debug("git cloning taskdir "+task._id.toString());
                //common.progress(task.progress_key+".prep", {progress: 0.5, msg: 'Installing/updating '+service+' service'});
                var repo_owner = service.split("/")[0];
                var cmd = "[ -d "+taskdir+" ] || "; //don't need to git clone if the taskdir already exists
                //TODO --recurse-submodules can be added here.. but I think people do that just to compile in some libs..
                //so until developers actually need them there, let's leave it
                cmd += "git clone -q --depth 1 ";
                if(task.service_branch) cmd += "-b '"+task.service_branch.addSlashes()+"' ";
                cmd += service_detail.git.clone_url+" "+taskdir;
                logger.debug("running %s", cmd);
                common.get_ssh_connection(resource, (err, conn)=>{
                    if(err) return next(err);
                    conn.exec("timeout 90 bash -c \""+cmd+"\"", function(err, stream) {
                        if(err) return next(err);
                        //common.set_conn_timeout(conn, stream, 1000*90); //timed out at 60 sec.. (should take 5-10s normally)
                        let last_error = "";
                        stream.on('close', function(code, signal) {
                            if(code === undefined) return next("timeout while git cloning");
                            else if(code) return next("Failed to git clone. code:"+code+" signal:"+signal+" "+last_error);
                            else next();
                        })
                        .on('data', function(data) {
                            logger.info(data.toString());
                        }).stderr.on('data', function(data) {
                            logger.info(data.toString());
                            last_error = data.toString();
                        });
                    });
                });
            },
            
            //update service
            next=>{
                //logger.debug("making sure requested service is up-to-date", task._id.toString());
                //conn.exec("timeout 45 bash -c \"cd "+taskdir+" && rm -f .git/*.lock && git fetch && git reset --hard && git pull && git lfs fetch --all && git log -1\"", (err, stream)=>{
                common.get_ssh_connection(resource, (err, conn)=>{
                    if(err) return next(err);
                    conn.exec("timeout 45 bash -c \"cd "+taskdir+" && rm -f .git/*.lock && git fetch && git reset --hard && git pull\"", (err, stream)=>{
                        if(err) return next(err);
                        stream.on('close', function(code, signal) {
                            if(code === undefined) {
                                return next("timeout while git pull");
                            } else if(code) {
                                return next("Failed to git pull code:"+code);
                            } 
                            next();
                        })
                        .on('data', function(data) {
                            logger.info(data.toString());
                        }).stderr.on('data', function(data) {
                            logger.info(data.toString());
                        });
                    });
                });
            },                

            //install config.json in the taskdir
            next=>{
                if(!task.config) {
                    logger.info("no config object stored in task.. skipping writing config.json");
                    return next();
                }

                logger.debug("installing config.json "+task._id.toString());
                common.get_ssh_connection(resource, (err, conn)=>{
                    if(err) return next(err);
                    conn.exec("timeout 10 cat > "+taskdir+"/config.json", function(err, stream) {
                        if(err) return next(err);
                        //common.set_conn_timeout(conn, stream, 1000*5);
                        stream.on('close', function(code, signal) {
                            if(code === undefined) return next("timedout while installing config.json");
                            else if(code) return next("Failed to write config.json");
                            else next();
                        })
                        .on('data', function(data) {
                            logger.info(data.toString());
                        }).stderr.on('data', function(data) {
                            logger.info(data.toString());
                        });
                        stream.write(JSON.stringify(task.config, null, 4));
                        stream.end();
                    });
                });
            },

            //write _.env.sh
            next=>{
                logger.debug("writing _env.sh "+task._id.toString());
                common.get_ssh_connection(resource, (err, conn)=>{
                    if(err) return next(err);
                    conn.exec("timeout 10 bash -c \"cd "+taskdir+" && cat > _env.sh && chmod +x _env.sh\"", function(err, stream) {
                        if(err) return next(err);
                        //common.set_conn_timeout(conn, stream, 1000*5);
                        stream.on('close', function(code, signal) {
                            if(code === undefined) return next("timedout while writing _env.sh");
                            else if(code) return next("Failed to write _env.sh -- code:"+code);
                            else next();
                        })
                        .on('data', function(data) {
                            logger.info(data.toString());
                        }).stderr.on('data', function(data) {
                            logger.info(data.toString());
                        });
                        stream.write("#!/bin/bash\n");

                        //write some debugging info
                        stream.write("# task id        : "+task._id.toString()+" (run "+(task.run+1)+" of "+(task.retry+1)+")\n");
                        var username = (resource.config.username||resource_detail.username);
                        var hostname = (resource.config.hostname||resource_detail.hostname);
                        stream.write("# resource       : "+resource_detail.name+" / "+resource.name+"\n");
                        stream.write("# resource       : "+resource.name+" ("+resource_detail.name+")\n");
                        stream.write("#                : "+username+"@"+hostname+"\n");
                        stream.write("# task dir       : "+taskdir+"\n");
                        if(task.remove_date) stream.write("# remove_date    : "+task.remove_date+"\n");

                        //write ENVs
                        for(var k in envs) {
                            var v = envs[k];
                            if(typeof v !== 'string') {
                                logger.warn("skipping non string value:"+v+" for key:"+k);
                                continue;
                            }
                            var vs = v.replace(/\"/g,'\\"'); //TODO - is this safe enough?
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
                            con.detail.msg.split("\n").forEach(line=>{
                                stream.write("#    "+line+"\n");
                            });
                        });
                        stream.write("\n");
                        stream.end();
                    });
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
                        logger.debug("syncing "+source_resource.name);
                        let source_path = common.gettaskdir(dep.instance_id, dep._id, source_resource);
                        let dest_path = common.gettaskdir(dep.instance_id, dep._id, resource);
                        let msg_prefix = "Synchronizing dependent task directory: "+(dep.desc||dep.name||dep._id.toString());
                        task.status_msg = msg_prefix;
                        task.save(err=>{
                            _transfer.rsync_resource(source_resource, resource, source_path, dest_path, progress=>{
                                task.status_msg = msg_prefix+" "+progress;
                                task.save(); 
                            }, err=>{
                                if(err) {
                                    //if its already synced, rsyncing is optional, so I don't really care about errors
                                    if(~common.indexOfObjectId(dep.resource_ids, resource._id)) {
                                        logger.warn("syncing failed, but we were able to sync it before.. processding with out syncing");
                                        return next_dep();
                                    }
                                    
                                    //need to release this so that resource.select will calculate resource availability correctly
                                    task.start_date = undefined; 
                                    task.status_msg = "Failed to synchronize dependent task directories.. will retry later -- "+err.toString();
                                    logger.warn("task:%s dep:%s .. %s", task._id, dep._id.toString(), task.status_msg);
                                    cb(); //I want to retry if rsyncing fails by leaving the task status to be requested
                                } else {
                                    logger.debug(["succeeded rsyncing.........", dep._id.toString()]);

                                    if(!~common.indexOfObjectId(dep.resource_ids, resource._id)) {
                                        //need to add dest resource to source dep
                                        logger.debug("adding new resource_id:%s", resource._id.toString());
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

                //save status since it might take a while to start
                task.status_msg = "Starting service";
                task.save(function(err) {
                    if(err) return next(err);
                    //BigRed2 seems to have AcceptEnv disabled in sshd_config - so I can't pass env via exec
                    common.get_ssh_connection(resource, (err, conn)=>{
                        if(err) return next(err);
                        conn.exec("timeout 20 bash -c \"cd "+taskdir+" && source _env.sh && "+service_detail.start+" >> start.log 2>&1\"", (err, stream)=>{
                            if(err) return next(err);
                            //common.set_conn_timeout(conn, stream, 1000*20);
                            stream.on('close', function(code, signal) {
                                if(code === undefined) return next("timedout while starting task");
                                else if(code) return next(service_detail.start+" failed. code:"+code+"");
                                else {
                                    task.next_date = new Date(); //so that we check the status soon
                                    task.run++;
                                    task.status = "running";
                                    task.status_msg = "Service started";
                                    next();
                                }
                            });

                            //NOTE - no stdout / err should be received since it's redirected to boot.log
                            stream.on('data', function(data) {
                                logger.info(data.toString());
                            });
                            stream.stderr.on('data', function(data) {
                                logger.info(data.toString());
                            });
                        });
                    });
                });
            },

            //TODO - I think I should deprecate this in the future, but it's still used by 
            //          * soichih/sca-service-noop (deprecated by brainlife/app-noop)
            //          * brainlife/app-noop
            //          * brain-life/validator-neuro-track
            //short sync job can be accomplished by using start.sh to run the (less than 30 sec) process and
            //status.sh checking for its output (or just assume that it worked)
            next=>{
                if(!service_detail.run) return next(); //not all service uses run (they may use start/status)

                logger.warn("running_sync service (deprecate!): "+taskdir+"/"+service_detail.run);
                //common.progress(task.progress_key, {status: 'running', msg: 'Running Service'});

                //need to save now for running_sync (TODO - I should call update instance?
                task.run++;
                task.status = "running_sync"; //mainly so that client knows what this task is doing (unnecessary?)
                task.status_msg = "Synchronously running service";
                task.save(function(err) {
                    if(err) return next(err);
                    //not updating instance status - because run should only take very short time
                    //BigRed2 seems to have AcceptEnv disabled in sshd_config - so I can't set env via exec opt
                    common.get_ssh_connection(resource, (err, conn)=>{
                        if(err) return next(err);
                        conn.exec("timeout 60 bash -c \"cd "+taskdir+" && source _env.sh && "+service_detail.run+" > run.log 2>&1\"", (err, stream)=>{
                            if(err) return next(err);
                            
                            //20 seconds too short to validate large dwi by validator-neuro-track
                            //TODO - I should really make validator-neuro-track asynchronous
                            //common.set_conn_timeout(conn, stream, 1000*60); 

                            stream.on('close', function(code, signal) {
                                if(code === undefined) next("timedout while running_sync");
                                else if(code) return next("failed to run (code:"+code+")");
                                else {
                                    load_product(taskdir, resource, function(err, product) {
                                        if(err) return next(err);
                                        //common.progress(task.progress_key, {status: 'finished', /*progress: 1,*/ msg: 'Service Completed'});
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
                                logger.info(data.toString());
                            });
                        });
                    });
                });
            },
            //done with all steps!
        ], cb);
    });
}

//TODO - this works, but we don't really need it yet.. if github cloning becomes a problem, we can switch to this?
//TODO - I am not sure zip download from github includes lfs content?
//returns (err, app_cache) app_cache will be set to false if other jobs seems to be staging the same cache
function cache_app(conn, service, workdir, taskdir, commit_id, cb) {
    let app_cache = workdir+"/"+service.split("/")[1]+"-"+commit_id;

    async.series([
        //cache the app on the remote resource
        next=>{
            logger.debug("checking app_cache %s", app_cache);
            conn.exec("timeout 30 ls "+app_cache, (err, stream)=>{
                if(err) return next(err);
                stream.on('close', (code, signal)=>{
                    if(code === undefined) return next("timeout while checking app_cache");
                    else if(code == 0) {
                        logger.debug("app cache exists");
                        return cb(null, app_cache);
                    } else logger.debug("no app cache");
                    next();
                })
                .on('data', function(data) {
                    logger.info(data.toString());
                });
            });
        },

        //check to see if other process is already downloading a cache
        next=>{
            conn.exec("timeout 30 stat --printf=\"%Y\" "+app_cache+".zip", (err, stream)=>{
                if(err) return next(err);
                let mod_s = "";
                stream.on('close', (code, signal)=>{
                    if(code === undefined) return next("timeout while checking app cache .zip");
                    else if(code == 0) {
                        let age = new Date().getTime()/1000 - mod_s;
                        logger.warn("app cache .zip exists.. I will wait.. mod time: %s age:%d(secs)", mod_s, age);
                        if(age < 60) return cb(null, false); //retry later.. maybe it's still getting downloaded
                        next(); //proceed and overwrite..
                    } else {
                        logger.debug("no app_cache .zip. proceed with download");
                        //TODO - it could happen that other download has just began.. might need to do flock?
                        next();
                    }
                })
                .on('data', function(data) {
                    logger.info(data.toString());
                    mod_s += data.toString();
                });
            });
        },

        //cache app and unzip, and unwind
        next=>{
            logger.info("caching app %s", app_cache+".zip");
            conn.exec("timeout 300 cat > "+app_cache+".zip && unzip -d "+app_cache+".unzip "+app_cache+".zip && mv "+app_cache+".unzip/*"+" "+app_cache+" && rm "+app_cache+".zip && rmdir "+app_cache+".unzip", (err, stream)=>{
                if(err) return next(err);
                stream.on('close', function(code, signal) {
                    if(code === undefined) return next("timedout while caching app");
                    else if(code) return next("Failed to cache app");
                    else {
                        logger.debug("successfully cached app");
                        next();
                    }
                })
                .on('data', function(data) {
                    logger.info(data.toString());
                }).stderr.on('data', function(data) {
                    logger.info(data.toString());
                });
                
                //download from github
                request.get({
                    url: "https://github.com/"+service+"/archive/"+commit_id+".zip", headers: {"User-Agent": "brainlife/amaretti"}, 
                }).pipe(stream); 
            });
        },
    ], err=>{
        cb(err, app_cache);
    });
}

function load_product(taskdir, resource, cb) {
    logger.debug("loading "+taskdir+"/product.json");
    common.get_sftp_connection(resource, function(err, sftp) {
        if(err) return cb(err);
        sftp.createReadStream(taskdir+"/product.json", (err, stream)=>{
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
                /*
                if(product_json.length > 1024*10) {
                    logger.warn("product.json is >10kb("+product_json.length+") It should be only a few kilobytes");
                }
                */
                if(product_json.length > 1024*1024) return cb("product.json is too big.. 1MB max (should be around a few kilobytes)");

                try {
                    var product = JSON.parse(product_json);
                    logger.info("successfully loaded product.json");
                    cb(null, product);
                } catch(e) {
                    logger.error("Failed to parse product.json (ignoring): "+e.toString());
                    cb();
                }
            });
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
        maxage: 1000*240,
    }

    async.series([
        
        //check counters
        next=>{
            //I haven't had a case where this wasn't a false alarm yet..
            /*
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
            */

            //similar code exists in /api/health.js
            /*
            if(ssh.max_channels > 5) {
                report.status = "failed";
                report.messages.push("high ssh channels "+ssh.max_channels);
            }
            */
            if(ssh.ssh_cons > 60) {
                report.status = "failed";
                report.messages.push("high ssh connections "+ssh.ssh_cons);
            }
            if(ssh.sftp_cons > 30) {
                report.status = "failed";
                report.messages.push("high sftp connections "+ssh.sftp_cons);
            }

            next();
        },
        
        //checking ssh agent
        next=>{
            common.sshagent_list_keys((err, keys)=>{
                if(err) {
                    report.status = 'failed';
                    report.messages.push(err);
                }
                report.agent_keys = keys.length;
                next();
            });
        },

        //check task handling queue
        next=>{
            db.Task.count({
                status: {$ne: "removed"}, //ignore removed tasks
                $or: [
                    {next_date: {$exists: false}},
                    {next_date: {$lt: new Date()}}
                ]
            }).exec((err, count)=>{
                if(err) return next(err);
                report.queue_size = count;
                if(count > 1000) {
                    report.status = "failed";
                    report.messages.push("high task queue count"+count);
                }
                next();
            });
        },

    ], err=>{
        if(err) return logger.error(err);
        logger.debug(JSON.stringify(report, null, 4));

        //send report
        rcon.set("health.amaretti.task."+(process.env.NODE_APP_INSTANCE||'0'), JSON.stringify(report));

        //reset counter
        _counts.checks = 0;
        _counts.tasks = 0;
        
    });
}

var rcon = redis.createClient(config.redis.port, config.redis.server);
rcon.on('error', err=>{throw err});
rcon.on('ready', ()=>{
    logger.info("connected to redis");
    setInterval(health_check, 1000*120);
});

health_check(); //initial check (I shouldn't do this anymore?)

/* task handling loop is pretty stable now.. so I don't need to do this anymore
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
                    request_date: new Date(),
                    config: { "test": 123 },
                    service: "brainlife/app-noop",  
                });
                task.save();
                return;
            }

            logger.debug(["health: noop status:", task.status, task._id.toString(), task.next_date]);
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
                task.request_date = new Date();
                task.request_count = 0;
                task.save();
            }
        });
    });
}
*/
