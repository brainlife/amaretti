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
const deepmerge = require('deepmerge');

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
});

//https://github.com/soichih/workflow/issues/15
function set_nextdate(task) {
    switch(task.status) {
    case "failed":
    case "finished":
    case "stopped":
        task.next_date = new Date(Date.now()+1000*3600*36);
        break;

    case "running":
        if(!task.start_date) console.error("status is set to running but no start_date set.. this shouldn't happen (but it did once) investigate!", task._id.toString());
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
    .populate('deps') //deprecated
    .populate('deps_config.task')
    .populate('follow_task_id')
    .exec((err, task) => {
        if(err) throw err; //throw and let pm2 restart
        if(!task) {
            logger.debug("nothing to do.. sleeping..");
            return setTimeout(check, 1000); 
        }

        //migrate old task deps to new deps_config
        if(task.deps && !task.deps_config) {
            task.deps_config = task.deps.map(dep=>{task: dep});
        }

        set_nextdate(task);
        _counts.tasks++;
        console.log("------- ", task.status, task.service, task.user_id, task._id.toString(), task.name);
        
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
            minage.setDate(minage.getDate() - 10); 
            var check_date = task.finish_date || task.fail_date;
            if(!check_date || check_date > minage) {
                logger.info("skipping missing task dir check - as this task is too fresh");
                return next();
            }

            //handling all resources in parallel - in a hope to speed things a bit.
            async.each(task.resource_ids, function(resource_id, next_resource) {
                db.Resource.findById(resource_id, function(err, resource) {
                    if(err) {
                        logger.error("failed to find resource_id:"+resource_id.toString()+" for taskdir check will try later");
                        return next_resource(err);
                    }
                    if(!resource || resource.status == 'removed') {
                        logger.info("can't check taskdir for task_id:"+task._id.toString()+" because resource_id:"+resource_id.toString()+" is removed.. assuming task dir to be gone");
                        
                        task.resource_ids.pull(resource_id);
                        return next_resource();
                    }
                    if(!resource.active) return next_resource("resource is inactive.. will try later");
                    if(!resource.status || resource.status != "ok") {
                        return next_resource("can't check taskdir on resource_id:"+resource._id.toString()+" because resource status is not ok.. will try later");
                    }

                    //all good.. now check to see if taskdir still exists (not purged by resource)
                    //logger.debug("getting sftp connection for taskdir check:"+resource_id);
                    common.get_sftp_connection(resource, function(err, sftp) {
                        if(err) {
                            logger.error(err);
                            return next_resource(); //maybe a temp. resource error?
                        }
                        var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
                        if(!taskdir || taskdir.length < 10) return next_resource("taskdir looks odd.. bailing");
                        //TODO is it better to use sftp?
                        logger.debug("querying ls %s", taskdir);
                        var t = setTimeout(function() { 
                            t = null; 
                            logger.error("timed out while trying to ls "+taskdir+" assuming it still exists");
                            next_resource();
                        }, 5000); 
                        sftp.readdir(taskdir, function(err, files) {
                            if(!t) return; //timeout already called

                            clearTimeout(t);
                            if(err) {
                                logger.debug(err);
                                logger.debug("let's assume directory is missing.. TODO - we need to parse the err to see why it failes.");
                                task.resource_ids.pull(resource_id);
                            } else {
                                //TODO - can I do something useful with files?
                                logger.debug("taskdir has %d files", files.length);
                            }
                            logger.debug("moving to the next resource");
                            next_resource();
                        });
                    });
                });
            }, err=>{
                if(err) {
                    logger.info(err); //continue
                    next();
                } else {
                    //now.. if we *know* that there are no more resource that has this task, consider it removed
                    if(task.resource_ids.length == 0) {
                        task.status = "removed"; //most likely removed by cluster
                        task.status_msg = "Output from this task seems to have been all removed";
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
                    task.status_msg = "Waiting for child tasks to finish before removing.. ";
                    task.next_date = new Date(Date.now()+1000*300); //5 minutes
                    return next(); //veto!
                }

                //ok.. it can be removed! (let removed task handler do the cleanup)
                task.status_msg = "waiting for workdirs to be removed";
                task.status = "removed";
                next();
            });
        },

        //TODO - stop tasks that got stuck in running / running_sync

    ], cb);
}

function handle_requested(task, next) {

    let now = new Date();

    //requested jobs are handled asynchrnously.. (start_date will be set while being handled)
    //if some api reset next_date, it could get reprocessed while it's starting up
    //so we need to bail if this is the cause
    if(task.start_date) {
        let starting_for = now - task.start_date;
        if(starting_for < 1000*3600) {
            logger.info("job seems to be starting.. "+starting_for);
            return next();
        }
        logger.error("start_ date is set on requested job, but it's been a while... guess it failed to start but didn't have start_date cleared.. proceeding?");
    }

    //make sure dependent tasks has all finished
    var deps_all_done = true;
    var failed_deps = [];
    var removed_deps = [];
    task.deps_config.forEach(function(dep) {
        if(dep.task.status != "finished") deps_all_done = false;
        if(dep.task.status == "failed") failed_deps.push(dep.task);
        if(dep.task.status == "removed") removed_deps.push(dep.task);
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

                    //penalize projects that are running a lot of jobs already (15 seconds per job)
                    //also add up to an hour for projects that has a lot of jobs requested (1 second each)
                    let secs = (15*running_count)+Math.min(requested_count, 3600);
                    secs = Math.max(secs, 15); //min 15 seconds

                    logger.info("%s -- retry in %d secs (running:%d requested:%d)", task.status_msg, secs, running_count, requested_count);
                    task.next_date = new Date(Date.now()+1000*secs);
                    next();
                });
            });
            return;
        }
        
        //set start date to *lock* this task
        task.status_msg = "Starting task";
        task.start_date = new Date();
        //task._considered = considered;
        task.resource_id = resource._id;
        if(!~common.indexOfObjectId(task.resource_ids, resource._id)) {
            logger.debug(["adding resource id", task.service, task._id.toString(), resource._id.toString()]);
            //TODO - this could cause concurrency issue sometimes (I should try $addToSet?)
            task.resource_ids.push(resource._id);
        }
        //need to save start_date to db so that other handler doesn't get called
        task.save(err=>{
            start_task(task, resource, considered, err=>{
                if(err) {
                    //permanently failed to start (or running_sync failed).. mark the task as failed
                    logger.error([task._id.toString(), err]);
                    task.status = "failed";
                    task.status_msg = err;
                    task.fail_date = new Date();
                } 

                if(task.status == "requested") {
                    //if it didn't start, reset start_date so we can handle it later again
                    task.start_date = undefined;
                    task.save();
                } else {
                    //either startup failed, or success
                    task.save(err=>{
                        if(err) logger.error(err);
                        common.update_instance_status(task.instance_id, err=>{
                            if(err) logger.error(err);
                        });
                    });
                }
            });

            //Don't wait for start_task to finish.. could take a while to start.. (especially rsyncing could take a while).. 
            //start_task is designed to be able to run concurrently..
            next();
        });

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
            if(err) {
                console.error(err);
                return next(err);
            }
            common.get_ssh_connection(resource, function(err, conn) {
                if(err) return next(err);
                var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
                console.log("running stop");
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

            common.get_ssh_connection(resource, (err, conn)=>{
                if(err) {
                    //retry laster..
                    task.status_msg = err.toString();
                    return next();
                }
                var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
                
                //delimite output from .bashrc to _status.sh so that I can grab a clean status.sh output
                var delimtoken = "=====WORKFLOW====="; 
                //console.debug("running status");
                conn.exec("timeout 45 bash -c \"cd "+taskdir+" && source _env.sh && echo '"+delimtoken+"' && "+service_detail.status+"\"", (err, stream)=>{
                    if(err) return next(err);
                    //common.set_conn_timeout(conn, stream, 1000*45);
                    var out = "";
                    stream.on('close', (code, signal)=>{
                        //remove everything before sca token (to ignore output from .bashrc)
                        var pos = out.indexOf(delimtoken);
                        out = out.substring(pos+delimtoken.length).trim();
                        //logger.debug(out);

                        switch(code) {
                        case undefined:
                            logger.debug("status timeout");
                            task.stauts_msg = "status unknown (timeout)"; //assume it to be still running..
                            next();
                            break;
                        case 0: //still running
                            logger.debug("still running");
                            if(out.length > 500) out = "... "+out.substring(out.length - 500); //grab the last N chars if it's too long
                            if(out.length == 0) out = ""; //empty log .. TODO - show something!
                            task.status_msg = out;
                            next();
                            break;
                        case 1: //finished
                            //I am not sure if I have enough usecases to warrent the automatical retrieval of product.json to task..
                            logger.debug("finished!");
                            load_product(taskdir, resource, async (err, product)=>{
                                if(err) {
                                    logger.info("failed to load product");
                                    task.status = "failed";
                                    task.status_msg = err;
                                    task.fail_date = new Date();
                                    next();
                                } else {
                                    task.finish_date = new Date();
                                    if(!task.start_date) task.start_date = task.create_date; //shoudn't happen, but it does sometimes.
                                    task.runtime = task.finish_date.getTime() - task.start_date.getTime();
                                    task.status = "finished";
                                    task.status_msg = "Successfully completed in "+(task.runtime/(1000*60)).toFixed(2)+" mins on "+resource.name;

                                    await storeProduct(task, product);
                                    rerun_child(task, next);
                                }
                            });
                            break;
                        case 2: //job failed
                            logger.debug("job failed");
                            task.status = "failed";
                            task.status_msg = out;
                            task.fail_date = new Date();
                            next();
                            break;
                        case 3: //status temporarly unknown
                            logger.error("couldn't determine the job state. could be an issue with status script on resource:%s", resource.name);
                            next();
                            break;
                        default:
                            //TODO - should I mark it as failed? or.. 3 strikes and out rule?
                            logger.error("unknown return code:"+code+" returned from _status.sh on resource:%s", resource.name);
                            next();
                        }
                    })
                    .on('data', data=>{
                        if(out.length > 1024*5) return; //too long.. truncate the rest..
                        out += data.toString();
                    }).stderr.on('data', data=>{
                        if(out.length > 1024*5) return; //too long.. truncate the rest
                        out += data.toString();
                    });
                });
            });
        });
    });
}

function rerun_child(task, cb) {
    //find all child tasks
    db.Task.find({'deps_config.task': task._id}, (err, tasks)=>{
        if(tasks.length) logger.debug("rerunning child tasks:"+tasks.length);
        //for each child, rerun
        async.eachSeries(tasks, (_task, next_task)=>{
            common.rerun_task(_task, null, next_task);
        }, cb);
    });
}

//initialize task and run or start the service
function start_task(task, resource, considered, cb) {
    var service = task.service; //TODO - should I get rid of this unwrapping? (just use task.service)
    if(service == null) return cb(new Error("service not set.."));
    _service.loaddetail(service, task.service_branch, (err, service_detail)=>{
        if(err) return cb(err);
        if(!service_detail) return cb("Couldn't find such service:"+service);

        var taskdir = common.gettaskdir(task.instance_id, task._id, resource);

        var envs = {
            SERVICE_DIR: ".", //deprecate! (there are some apps still using this..)
            
            //useful to construct job name?
            TASK_ID: task._id.toString(),
            USER_ID: task.user_id,
            SERVICE: task.service,
        };
        task._envs = envs;

        if(task.service_branch) envs.SERVICE_BRANCH = task.service_branch;

        //override with any resource instance envs
        if(resource.envs) for(var key in resource.envs) {
            envs[key] = resource.envs[key];
        }

        logger.debug("starting task on "+resource.name);
        async.series([
            
            //query current github commit id
            next=>{
                _service.get_sha(service, task.service_branch, (err, ref)=>{
                    if(err) {
                        logger.error("failed to obtain commit id from github.. maybe service/branch no longer exists?");
                        console.error(err);
                        //return next(err); //can't convert to string?
                        return next("failed to get commit id from github. Did service/branch name change?");
                    }
                    //console.log(ref.sha);
                    task.commit_id = ref.sha;
                    next();
                });
            },

            //setup taskdir using app cache
            next=>{
                console.log("get_ssh_connection to setup taskdir");
                common.get_ssh_connection(resource, (err, conn)=>{
                    if(err) return next(err);
                    let workdir = common.getworkdir(null, resource);
                    cache_app(conn, service, workdir, taskdir, task.commit_id, (err, app_cache)=>{
                        if(err) return next(err);
                        if(!app_cache) {

                            //TODO - not working?
                            task.next_date = new Date(Date.now()+1000*300);
                            task.status_msg = "Waiting for the App to be installed (5mins)";

                            return cb(); //cache already inprogress.. retry later..
                        }
                        
                        //TODO - this doesn't copy hidden files (like .gitignore).. it's okay?
                        console.debug("mkdir/rsync appcache, etc..");
                        conn.exec("timeout 30 mkdir -p "+taskdir+" && timeout 90 rsync -av "+app_cache+"/ "+taskdir, (err, stream)=>{
                            if(err) return next(err);
                            stream.on('close', (code, signal)=>{
                                if(code === undefined) return next("timeout while creating taskdir");
                                if(code != 0) return next("failed to create taskdir.. code:"+code)
                                logger.debug("taskdir created");
                                next();
                            })
                            .on('data', function(data) {
                                console.log(data.toString());
                            }).stderr.on('data', function(data) {
                                console.error(data.toString());
                            });
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

                common.get_ssh_connection(resource, (err, conn)=>{
                    if(err) return next(err);
                    console.log("installing config.json");
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
            //TODO - tried to pass all envs as part of command line that I am passing to start.sh, but couldn't quite make it work
            next=>{
                common.get_ssh_connection(resource, (err, conn)=>{
                    if(err) return next(err);
                    console.log("writing _env.sh");
                    conn.exec("timeout 10 bash -c \"cd "+taskdir+" && cat > _env.sh && chmod +x _env.sh\"", function(err, stream) {
                        if(err) return next(err);
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
                        var username = resource.config.username;//||resource_detail.username);
                        var hostname = resource.config.hostname;//||resource_detail.hostname);
                        stream.write("# resource       : "+resource.name+"\n"); //+" ("+resource_detail.name+")\n");
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
                        considered.forEach(con=>{
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
                if(!task.deps_config) return next(); //no deps then skip
                async.eachSeries(task.deps_config, function(dep, next_dep) {
                    
                    //if resource is the same, don't need to sync
                    if(task.resource_id.toString() == dep.task.resource_id.toString()) return next_dep();

                    //go through all resource_id that this task might be stored at 
                    async.eachSeries([dep.task.resource_id, ...dep.task.resource_ids.reverse()], (source_resource_id, next_source)=>{

                        //see if we can use this resource..
                        db.Resource.findById(source_resource_id, function(err, source_resource) {
                            if(err) return next_source(err); //db error?
                            if(!source_resource.active) {
                                task.status_msg = "resource("+source_resource.name+") which contains the input data is not active.. try next source.";
                                return next_source(); 
                            }

                            let source_path = common.gettaskdir(dep.task.instance_id, dep.task._id, source_resource);
                            let dest_path = common.gettaskdir(dep.task.instance_id, dep.task._id, resource);
                            let msg_prefix = "Synchronizing dependent task directory: "+(dep.task.desc||dep.task.name||dep.task._id.toString());
                            task.status_msg = msg_prefix;
                            let saving_progress = false;
                            task.save(err=>{
                                _transfer.rsync_resource(source_resource, resource, source_path, dest_path, dep.subdirs, progress=>{
                                    //console.log("saving task progress", progress);
                                    task.status_msg = msg_prefix+" "+progress;
                                    saving_progress = true;
                                    task.save(()=>{
                                        saving_progress = false;
                                    }); 
                                }, err=>{
                                    
                                    //I have to wait to make sure task.save() in progress finish writing - before moving to
                                    //the next step - which may run task.save() immediately which causes
                                    //"ParallelSaveError: Can't save() the same doc multiple times in parallel. "
                                    function wait_progress_save() {
                                        if(saving_progress) {
                                            logger.error("waiting for progress task.save()");
                                            return setTimeout(wait_progress_save, 500);
                                        }

                                        if(err) {
                                            task.status_msg = "Failed to synchronize dependent task directories.. "+err.toString();
                                            next_source(); 
                                        } else {
                                            //success! let's records new resource_ids and proceed to the next dep
                                            //only if length is not set (copy all mode). if we are doing partial syncing, we don't want to mark it on database as full copy
                                            if(dep.subdirs.length) {
                                                console.debug("partial synced");
                                                return next_dep();
                                            }

                                            logger.debug("adding new resource_id (could cause same doc in parallel error? :%s", resource._id.toString());
                                            //tryint $addToSet to see if this could prevent the following issue
                                            //"ParallelSaveError: Can't save() the same doc multiple times in parallel."
                                            db.Task.findOneAndUpdate({_id: dep.task._id}, {
                                                $addToSet: {
                                                    resource_ids: resource._id.toString(),
                                                }
                                            }, next_dep);
                                        }
                                    }

                                    setTimeout(wait_progress_save, 500);
                                });
                            });
                        });
                    }, err=>{
                        if(err) return next_dep(err);

                        //if its already synced, rsyncing is optional, so I don't really care about errors
                        if(~common.indexOfObjectId(dep.task.resource_ids, resource._id)) {
                            logger.warn("syncing failed.. but we were able to sync before.. proceeding to next dep");
                            return next_dep();
                        }

                        task.status_msg = "Couldn't sync dep task from any resources.. will try later";
                        cb(); 
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
                        console.log("writing _env.sh(run)");
                        conn.exec("timeout 30 bash -c \"cd "+taskdir+" && source _env.sh && "+service_detail.start+" >> start.log 2>&1\"", (err, stream)=>{
                            if(err) return next(err);
                            //common.set_conn_timeout(conn, stream, 1000*20);
                            stream.on('close', function(code, signal) {
                                if(code === undefined) return next("timedout while starting task");
                                else if(code) return next(service_detail.start+" failed. code:"+code+" (maybe start timeout?)");
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
            //          * brainlife/app-noop

            //short sync job can be accomplished by using start.sh to run the (less than 30 sec) process and
            //status.sh checking for its output (or just assume that it worked)
            next=>{
                if(!service_detail.run) return next(); //not all service uses run (they may use start/status)

                logger.warn("running_sync service (deprecate!): "+taskdir+"/"+service_detail.run);

                //need to save now for running_sync (TODO - I should call update instance?
                task.run++;
                task.status = "running_sync"; //mainly so that client knows what this task is doing (unnecessary?)
                task.status_msg = "Synchronously running service";
                task.save(err=>{
                    if(err) return next(err);
                    //not updating instance status - because run should only take very short time
                    //BigRed2 seems to have AcceptEnv disabled in sshd_config - so I can't set env via exec opt
                    common.get_ssh_connection(resource, (err, conn)=>{
                        if(err) return next(err);
                        console.log("writing _env.sh(run-sync)");
                        conn.exec("timeout 60 bash -c \"cd "+taskdir+" && source _env.sh && "+service_detail.run+" > run.log 2>&1\"", (err, stream)=>{
                            if(err) return next(err);
                            
                            //20 seconds too short to validate large dwi by validator-neuro-track
                            //TODO - I should really make validator-neuro-track asynchronous
                            //common.set_conn_timeout(conn, stream, 1000*60); 

                            stream.on('close', function(code, signal) {
                                if(code === undefined) next("timedout while running_sync");
                                else if(code) return next("failed to run (code:"+code+")");
                                else {
                                    load_product(taskdir, resource, async function(err, product) {
                                        if(err) return next(err);
                                        //common.progress(task.progress_key, {status: 'finished', /*progress: 1,*/ msg: 'Service Completed'});
                                        task.status = "finished";
                                        task.status_msg = "Service ran successfully";
                                        task.finish_date = new Date();

                                        await storeProduct(task, product);
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

//TODO - I am not sure zip download from github includes lfs content?
//returns (err, app_cache) app_cache will be set to false if other jobs 
//seems to be staging the same cache
function cache_app(conn, service, workdir, taskdir, commit_id, cb) {
    let app_cache = workdir+"/appcache/"+service.split("/")[1]+"-"+commit_id;

    async.series([

        //make sure appcache parent directory exists
        next=>{
            let app_cache_dir = path.dirname(app_cache);
            conn.exec("timeout 30 mkdir -p "+app_cache_dir, (err, stream)=>{
                if(err) return next(err);
                stream.on('close', (code, signal)=>{
                    if(code === undefined) return next("timeout while creating appcache directory");
                    else if(code == 0) {
                        return next();
                    } else next("failed to create appcache directory");
                })
                .on('data', function(data) {
                    logger.info(data.toString());
                });
            });
        },
        
        //see if app cache directory is not empty (purged?)
        //TODO - what was the point of this?
        next=>{
            conn.exec("timeout 30 find "+app_cache+" -depth -empty -delete", (err, stream)=>{
                if(err) return next(err);
                stream.on('close', (code, signal)=>{
                    if(code === undefined) return next("timeout while trying to remove empty app cache directory");
                    if(code == 1) return next(); //no such directory
                    if(code != 0) return next("failed to (try) removing empty directory");
                    logger.debug("rmdir of app cache successfull.. which means it was empty");
                    next(); 
                })
                .on('data', data=>{
                    logger.info(data.toString());
                });
            });
        },

        //see if app is cached already
        next=>{
            //logger.debug("checking app_cache %s", app_cache);
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
            conn.exec("(set -o pipefail; timeout 30 stat --printf=\"%Y\" "+app_cache+".zip || touch "+app_cache+".zip)", (err, stream)=>{
                if(err) return next(err);
                let mod_s = "";
                stream.on('close', (code, signal)=>{
                    if(code === undefined) return next("timeout while checking app cache .zip");
                    else if(code == 0) {
                        let age = new Date().getTime()/1000 - mod_s;
                        logger.warn("app cache .zip exists.. I will wait.. mod time: %s age:%d(secs)", mod_s, age);
                        if(age < 60) {
                            //task.next_date = new Date(Date.now()+1000*600);
                            //task.status = "Waiting for App to be installed";
                            return cb(null, false); //retry later.. maybe it's still getting downloaded
                        }
                        next(); //proceed and overwrite..
                    } else {
                        logger.debug("no app_cache .. proceed with download. code:"+code);
                        //TODO - it could happen that other download has just began.. might need to do flock?
                        next();
                    }
                })
                .on('data', function(data) {
                    logger.info(data.toString());
                    mod_s += data.toString();
                }).stderr.on('data', function(data) {
                    console.error(data.toString());
                });
            });
        },

        //cache app and unzip, and unwind
        next=>{
            logger.info("caching app %s", app_cache+".zip");
            conn.exec("timeout 300 cat > "+app_cache+".zip && unzip -o -d "+app_cache+".unzip "+app_cache+".zip && rm -rf "+app_cache+" && mv "+app_cache+".unzip/*"+" "+app_cache+" && rm "+app_cache+".zip && rmdir "+app_cache+".unzip", (err, stream)=>{
                if(err) return next(err);
                stream.on('close', function(code, signal) {
                    //TODO - should I remove the partially downloaded zip?
                    if(code === undefined) return next("timedout while caching app");
                    else if(code) return next("failed to cache app .. code:"+code);
                    else {
                        logger.debug("successfully cached app");
                        next();
                    }
                })
                .on('data', function(data) {
                    console.log(data.toString());
                }).stderr.on('data', function(data) {
                    console.error(data.toString());
                });
                
                //download from github
                request.get({
                    url: "https://github.com/"+service+"/archive/"+commit_id+".zip", 
                    headers: {
                        "User-Agent": "brainlife/amaretti",
                        "Authorization": "token "+config.github.access_token, //for private repo
                    }, 
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
        console.debug("sftp_connection returned");
        if(err) return cb(err);
        console.debug("creating readstream");
        sftp.createReadStream(taskdir+"/product.json", (err, stream)=>{
            if(err) return cb(err);
            console.debug("stream ready for product.json");
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

async function storeProduct(task, dirty_product) {
    logger.info("storing product");
    product = common.escape_dot(dirty_product);

    //for validation task, I need to merge product from the main task 
    //TODO - this is more of a warehouse behavior?
    if(task.follow_task_id) {
        let follow_product = await db.Taskproduct.findOne({task_id: task.follow_task_id}).lean().exec();
        if(follow_product && follow_product.product) {
            
            //mark some brainlife UI elements that it's from the follow_task.. so we can avoid 
            //showing it twice.
            if(follow_product.product.brainlife) {
                follow_product.product.brainlife.forEach(item=>{
                    item._follow = true;
                });
            }

            product = deepmerge(product, follow_product.product); //TODO shouldn't product have precidence over follow_product?
        }
    }

    await db.Taskproduct.findOneAndUpdate({task_id: task._id}, {product}, {upsert: true});
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
                if(count > 3000) {
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
        rcon.set("health.amaretti.task."+process.env.HOSTNAME+"-"+process.pid, JSON.stringify(report));

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


