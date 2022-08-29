#!/usr/bin/env node


//make require to work while we migrate to import
//import { createRequire } from "module";
//const require = createRequire(import.meta.url);

const fs = require('fs');
const path = require('path');
const os = require('os');
const redis = require('redis');
const async = require('async');
const deepmerge = require('deepmerge');
const yargs = require('yargs');

const stripAnsi = require('strip-ansi');

const config = require('../config');
const db = require('../api/models');
const common = require('../api/common');
const _resource_select = require('../api/resource').select;
const _transfer = require('../api/transfer');
const _service = require('../api/service');

const pkg = require('../package.json');

const argv = yargs
    .option('nonice', {
        alias: 't',
        description: 'skip nice tasks',
        type: 'boolean',
    })
    .help()
    .alias('help', 'h')
    .argv;

//keep up with which resources are currently accessed (fetching input data)
let resourceSyncCount = {};
//remove old resourceSyncCount entry..
//this is an attempt to test a theory that resourceSyncCount gets stuck (transfer function cb doesn't fire)
//if this cures the problem, then we should investigate why transfer cb doesn't fire and fix it.
//if this doesn't help, then get rid of this setInterval
setInterval(()=>{
    const old = new Date(Date.now()-1000*900);
    for(const resource_id in resourceSyncCount) {
        for(const task_id in resourceSyncCount[resource_id]) {
            const rdate = resourceSyncCount[resource_id][task_id];
            if(rdate < old) {
                console.error("resourceSyncCount--", resource_id, task_id, rdate, "too old.. removing");
                delete resourceSyncCount[resource_id][task_id];

                //keep record of this happening
                //resourceSyncCount[resource_id][task_id+".timeout"] = new Date();
            }
        }
    }
}, 1000*5);

console.log(`
------------------- amaretti (pid: ${process.pid}) ----------------------
${new Date().toString()}
`);

db.init(function(err) {
    if(err) throw err;
    console.debug("db-initialized");
    check(); //start check loop
});

//https://github.com/soichih/workflow/issues/15
function setNextDate(task) {
    switch(task.status) {
    case "failed":
    case "finished":
    case "stopped":
        task.next_date = new Date(Date.now()+1000*3600*36); //1.5 days
        break;

    case "running":
        if(!task.start_date) console.error("status is set to running but no start_date set.. this shouldn't happen (but it happens!) investigate!", task._id.toString());
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
        console.log("don't know how to set next_date for running_sync..");
        //TODO - maybe fail the task if it's running too long?
        task.next_date = new Date(Date.now()+1000*3600); 
        break;
    default:
        console.log(["don't know how to calculate next_date for status",task.status," -- setting to 1hour"]);
        task.next_date = new Date(Date.now()+1000*3600); 
    }
}

function check(cb) {
    _counts.checks++; //for health reporting

    const query = {
        status: {$ne: "removed"}, //ignore removed tasks
        //status: {$nin: ["removed", "failed"]}, //ignore removed tasks
        $or: [
            {next_date: {$exists: false}},
            {next_date: {$lt: new Date()}}
        ]
    }
    if(argv.nonice) query.nice = {$exists: false};
    else query.nice = {$exists: true};

    db.Task.findOne(query)
    //sorting slows down the query significantly.. let's just be smart about setting next_date 
    //and make sure we don't go too delinquent
    //.sort('nice next_date') //handle nice ones later, then sort by next_date (this slows the query down)
    .populate('deps') //deprecated
    .populate('deps_config.task')
    .populate('follow_task_id')
    .exec((err, task) => {
        if(err) throw err; //throw and let pm2 restart
        if(!task) {
            console.debug(new Date(), "nothing to do.. sleeping..", argv.nonice?"(nonice)":"(nice)");
            return setTimeout(check, 1000); 
        }

        //migrate old task deps to new deps_config
        if(task.deps && !task.deps_config) {
            task.deps_config = task.deps.map(dep=>{task: dep});
        }

        setNextDate(task);
        _counts.tasks++;
        console.log("------- ", task._id.toString(), "user:", task.user_id, task.status, task.service, task.name);
        //console.log("request_date", task.request_date);
        //console.log("start_date", task.start_date);
        
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
        task.handle_date = new Date(); 
        handler(task, async (err, skipSave)=>{
            if(err) console.error(err); //continue

            //handle_requested split start_task which does its own task.save().
            //to prevent parallel save, I let the last save from handle_requested by start_task
            //so we should not save here.. 
            if(!skipSave) await task.save();

            //if task status changed, update instance status also
            if(task.status == previous_status) return check(); //no change
            common.update_instance_status(task.instance_id, err=>{
                if(err) console.error(err);
                check();
            });
        });
    });
}

function handle_housekeeping(task, cb) {
    //console.debug("houskeeping!");
    async.series([

        //for validator (with follow_task_id) if the parent task is removed, we should mark the task as removed also
        next=>{
            if(!task.follow_task_id) return next();
            db.Task.findById(task.follow_task_id).then(followTask=>{
                if(!followTask) return next(); //just in case.
                if(followTask.status != "removed") return next(); //nothing to do then

                //remove validator if parent task is removed
                console.log("parent task is removed. we need to remove this one also");
                task.remove_date = new Date();
                next();
            });
        },

        //check to see if taskdir still exists
        //TODO...
        //taskdir could *appear* to be gone if admin temporarily unmount the file system, or metadata server is slow, etc, etc..
        //I need to be really be sure that the directory is indeed removed before concluding that it is.
        //To do that, we either need to count the number of times it *appears* to be removed, or do something clever.
        //TODO..
        //I need to solve this.. if task gets removed by resource, we need to mark the task as removed or dependending task
        //will fail! For now, we can make sure that resource won't remove tasks for at least 10 days... Maybe we could make this
        //number configurable for each task?
        next=>{
            //for now, let's only do this check if finish_date or fail_date is sufficiently old
            var minage = new Date();
            minage.setDate(minage.getDate() - 10); 
            var check_date = task.finish_date || task.fail_date;
            if(!check_date || check_date > minage) {
                console.log("skipping missing task dir check - as this task is too fresh");
                return next();
            }

            //handling all resources in parallel - in a hope to speed things a bit.
            async.each(task.resource_ids, function(resource_id, next_resource) {
                db.Resource.findById(resource_id, function(err, resource) {
                    if(err) {
                        console.error("failed to find resource_id:"+resource_id.toString()+" for taskdir check will try later");
                        return next_resource(err);
                    }
                    if(!resource || resource.status == 'removed') {
                        console.log("can't check taskdir for task_id:"+task._id.toString()+" because resource_id:"+resource_id.toString()+" is removed.. assuming task dir to be gone");
                        
                        task.resource_ids.pull(resource_id);
                        return next_resource();
                    }
                    if(!resource.active) return next_resource("resource is inactive.. will try later");
                    if(!resource.status || resource.status != "ok") {
                        return next_resource("can't check taskdir on resource_id:"+resource._id.toString()+" because resource status is not ok.. will try later");
                    }

                    //all good.. now check to see if taskdir still exists (not purged by resource)
                    //console.debug("getting sftp connection for taskdir check:"+resource_id);
                    common.get_sftp_connection(resource, function(err, sftp) {
                        if(err) {
                            console.error(err);
                            return next_resource(); //maybe a temp. resource error?
                        }
                        var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
                        if(!taskdir || taskdir.length < 10) return next_resource("taskdir looks odd.. bailing");
                        console.debug("sftp.readdir %s", taskdir);
                        var t = setTimeout(function() { 
                            t = null; 
                            console.error("timed out while trying to readdir "+taskdir+" assuming it still exists");
                            next_resource();
                        }, 2500); 
                        sftp.readdir(taskdir, function(err, files) {
                            if(!t) return; //timeout already called
                            clearTimeout(t);
                            if(err) {
                                console.debug(err.toString());
                                if(err.code == 2) {
                                    //directory went missing.. removing resource_id
                                    task.resource_ids.pull(resource_id);
                                } else {
                                    console.error("unknown error while checking directory..")
                                    console.error(err);
                                }
                            } else {
                                //TODO - can I do something useful with files?
                                console.debug("taskdir still has %d files", files.length);
                            }
                            console.debug("moving to the next resource");
                            next_resource();
                        });
                    });
                });
            }, err=>{
                if(err) {
                    console.log(err); //continue
                    next();
                } else {
                    //now.. if we *know* that there are no more resource that has this task, consider it removed
                    if(task.resource_ids.length == 0) {
                        task.status = "removed"; //most likely removed by cluster
                        task.status_msg = "Output from this task seems to have been all removed";
                    }
                    console.log("done dealing with resourxces");
                    next();
                }
            });
        },

        //remove task dir?
        next=>{
            var need_remove = false;

            //check for early remove specified by user
            var now = new Date();
            if(task.remove_date && task.remove_date <= now) {
                console.log("remove_date is set and task is passed the date");
                need_remove = true;
            }

            //if remove_date isn't set.. remove task that's more than 3 months
            if(!task.remove_date) {
                var maxage = new Date();
                maxage.setDate(now.getDate() - 90);
                if(task.create_date < maxage) {
                    need_remove = true;
                }
            }

            //no need to remove, then no need to go further
            if(!need_remove) return next();

            //find any tasks that depends on me.. 
            db.Task.findOne({ 
                "deps_config.task": task._id, 
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
    ], (err, results)=>{
        cb(err);
    });
}

async function handle_requested(task, next) {

    const now = new Date();
    let initialState = task.status;

    //requested jobs are handled asynchronously.. (start_date will be set while being handled)
    //if some api reset next_date, it could get reprocessed while it's starting up
    //so we need to bail if this is the cause
    //WARNING - don't run anything asynchrnous after checking for task.start_date before I save the task with new start_date 
    if(task.start_date) {
        let starting_for = now - task.start_date;
        //console.log("start_date is set", starting_for);
        if(starting_for < 1000*60*30) {
            console.log("job seems to be still starting.. for "+starting_for);
            task.status_msg = "Job poked at "+now.toLocaleString()+" but job is still starting.. for "+starting_for/1000+"secs";
            return next();
        }
        //console.error("start_date is set on requested job, but it's been a while... guess it failed to start but didn't have start_date cleared.. proceeding?");
    } 

    //check if remove_date has  not been reached (maybe set by request_task_removal got overridden)
    if(task.remove_date < now) {
        task.status_msg = "Requested but it is past the remove date";
        task.status = "stopped"; //not yet started.. just stop
        task.next_date = undefined; //let house keeper remove it immediately
        return next();
    }

    //make sure dependent tasks has all finished
    var deps_all_done = true;
    var failed_deps = [];
    var removed_deps = [];
    task.deps_config.forEach(function(dep) {
        if(!dep.task) {
            //task removed by administrator? (I had to remove task with user_id set to "warehouse" once)
            removed_deps.push(dep.task);
            return;
        }
        if(dep.task.status != "finished") deps_all_done = false;
        if(dep.task.status == "failed") failed_deps.push(dep.task);
        if(dep.task.status == "removed") removed_deps.push(dep.task);
    });

    //fail the task if any dependency fails
    //TODO - maybe make this optional based on task option?
    if(failed_deps.length > 0) {
        console.debug("dependency failed.. failing this task");
        task.status_msg = "Dependency failed.";
        task.status = "failed";
        task.fail_date = new Date();
        return next();
    }

    //fail the task if any dependency is removed
    if(removed_deps.length > 0) {
        console.debug("dependency removed.. failing this task");
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
        console.debug("dependency not met.. postponing");
        task.status_msg = "Waiting on dependencies";
        //when dependency finished, it should auto-poke this task. so it's okay for this to be long
        task.next_date = new Date(Date.now()+1000*3600*24); 
        return next();
    }

    //set start date before checking for resource_select to prevent this task from getting double processed
    //also make sure we get correct count for running/starting task in score_resource
    task.status_msg = "Looking for resource";
    task.start_date = new Date();
    await task.save()

    _resource_select({
        //mock user object
        sub: task.user_id,
        gids: task.gids,
    }, task, async (err, resource, score, considered)=>{
        if(err) return next(err);
        if(!resource || resource.status == "removed") {

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

                    console.log("can't find resource.. retry in %d secs -- running:%d group_id:%d(requested:%d)", secs, running_count, task._group_id, requested_count);

                    task.status_msg = "No resource currently available to run this task.. waiting.. ";
                    task.next_date = new Date(Date.now()+1000*secs);
                    task.start_date = undefined; //reset start_date so it will be handled again later
                    return next();
                });
            });
            return;
        }

        //we need to mark starting resource id so we don't over count while starting jobs
        task.resource_id = resource._id;
        await task.save();

        //ready to start it! (THIS FORKS the handler)
        start_task(task, resource, considered, err=>{
            if(err) {
                //permanently failed to start (or running_sync failed).. mark the task as failed
                console.error("start_task failed. taskid:", task._id.toString(), err);
                task.status = "failed";
                task.status_msg = err;
                task.fail_date = new Date();
            } 

            task.resource_ids.addToSet(resource._id);

            //if we couldn't start (in case of retry), reset start_date so we can handle it later again
            if(task.status == "requested") task.start_date = undefined;

            //check() handles save/update_instance_status, but we are diverging here..
            console.log(task.status_msg);

            task.save(err=>{
                if(err) console.error(err);

                //if status changes, then let's update instance status also
                if(task.status != initialState) {
                    common.update_instance_status(task.instance_id, err=>{
                        if(err) console.error(err);
                    });
                }
            });
        });

        //Don't wait for start_task to finish.. could take a while to start.. (especially rsyncing could take a while).. 
        //start_task is designed to be able to run concurrently..
        console.log("started task.. skiping save");
        next(null, true); //skip saving to prevent parallel save with start_task
    });
}

function handle_stop(task, next) {
    console.log("handling stop request "+task._id.toString());

    //if not yet submitted to any resource, then it's easy
    if(!task.resource_id) {
        task.status = "removed";
        task.status_msg = "Removed before ran on any resource";
        return next();
    }

    db.Resource.findById(task.resource_id, function(err, resource) {
        if(err) return next(err);
        if(!resource || resource.status == "removed") {
            console.error("can't stop task_id:"+task._id.toString()+" because resource_id:"+task.resource_id+" no longer exists");
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
                            task.status_msg = "Connection terminated while trying to stop the task";
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
                        console.log(data.toString());
                    }).stderr.on('data', function(data) {
                        console.log(data.toString());
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
        console.log("task running too long.. stopping "+runtime);
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
                console.error("Couldn't load package detail for service:"+task.service);
                return next(err); 
            }

            common.get_ssh_connection(resource, (err, conn)=>{
                if(err) {
                    task.status_msg = err.toString();
                    return next();
                }
                var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
                
                //delimite output from .bashrc to _status.sh so that I can grab a clean status.sh output
                var delimtoken = "=====WORKFLOW====="; 
                conn.exec("timeout 10 bash -c \"cd "+taskdir+" && source _env.sh && echo '"+delimtoken+"' && "+service_detail.status+"\"", (err, stream)=>{
                    if(err) return next(err);
                    //common.set_conn_timeout(conn, stream, 1000*45);
                    var out = "";
                    stream.on('close', (code, signal)=>{
                        //remove everything before delimiter token (to ignore output from .bashrc)
                        var pos = out.indexOf(delimtoken);
                        out = out.substring(pos+delimtoken.length).trim();

                        //remove non ascii..
                        //out = out.replace(/[^\x00-\x7F]/g, ""); //remove nonascii
                        out = stripAnsi(out);

                        switch(code) {
                        case undefined:
                            console.debug("status timeout");
                            task.stauts_msg = "status unknown (timeout)"; //assume it to be still running..
                            next();
                            break;
                        case 0: //still running
                            console.debug("still running");
                            if(out.length > 500) out = "... "+out.substring(out.length - 500); //grab the last N chars if it's too long
                            if(out.length == 0) out = ""; //empty log .. TODO - show something!
                            task.status_msg = out;
                            next();
                            break;
                        case 1: //finished
                            //I am not sure if I have enough use cases to warrent the automatical retrieval of product.json to task..
                            console.debug("finished!");
                            load_product(taskdir, resource, async (err, product)=>{
                                if(err) {
                                    console.log("failed to load product");
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
                            console.debug("job failed");
                            task.status = "failed";
                            task.status_msg = out;
                            task.fail_date = new Date();
                            poke_next(task, next);
                            break;
                        case 3: //status temporarly unknown
                            //TODO - I should mark the job as failurer if it's been a long time since last good status output
                            //of 3 stries and out?
                            console.error("couldn't determine the job state. could be an issue with status script on resource:%s", resource.name, task.instance_id+"/"+task._id);
                            console.error(out);
                            task.status_msg = out;
                            next();
                            break;
                        default:
                            //TODO - should I mark it as failed? or.. 3 strikes and out rule?
                            console.error("unknown return code:"+code+" returned from _status.sh on resource:%s", resource.name);
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
    db.Task.find({
        "deps_config.task": task._id,

        //when a rule is turned off and job is removed, staging might finish after it's removed
        //and re-start the following job! let's rerun if the state is anything other than removed
        //I am afraid this might prevent old vis jobs from getting rerun if it's already removed
        //but UI does rerun of removed job manually (mixin/wait.js).. so I believe it's ok..
        "status": {$ne: "removed"},
    }, (err, tasks)=>{
        if(tasks.length) console.debug("rerunning child tasks:"+tasks.length);
        //for each child, rerun
        async.eachSeries(tasks, (_task, next_task)=>{
            common.rerun_task(_task, null, next_task);
        }, cb);
    });
}

function poke_next(task, cb) {
    //find all child tasks
    db.Task.find({
        "deps_config.task": task._id,
    }, (err, tasks)=>{
        //and *poke* them..
        async.eachSeries(tasks, (_task, next_task)=>{
            _task.next_date = undefined;
            _task.save(next_task);
        }, cb);
    });
}


//initialize task and run or start the service
function start_task(task, resource, considered, cb) {
    var service = task.service; //TODO - should I get rid of this unwrapping? (just use task.service)
    if(service == null) return cb(new Error("service not set.."));
    _service.loaddetail(service, task.service_branch, (err, service_detail)=>{
        if(err) return cb(err);
        if(!service_detail) return cb("Couldn't find such service:"+service+" - if the repo is private, please invite brlife github user ID with read access");

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

        console.debug("starting task on "+resource.name);
        async.series([
            
            //make sure dep task dirs are synced first
            next=>{
                if(!task.deps_config) return next(); //no deps then skip
                async.eachSeries(task.deps_config, function(dep, next_dep) {
                    
                    //if resource is the same, don't need to sync
                    if(resource._id.toString() == dep.task.resource_id.toString()) return next_dep();

                    //go through all resource_id that this task might be stored at 
                    async.eachSeries([dep.task.resource_id, ...dep.task.resource_ids.reverse()], (source_resource_id, next_source)=>{

                        //see if we can use this resource..
                        db.Resource.findById(source_resource_id, function(err, source_resource) {
                            if(err) return next_source(err); //db error?
                            if(!source_resource.active) {
                                task.status_msg = "resource("+source_resource.name+") which contains the input data is not active.. try next source.";
                                return next_source(); 
                            }
                            
                            //make sure we don't sync too many times from a single resource
                            if(!resourceSyncCount[source_resource_id]) resourceSyncCount[source_resource_id] = {};
                            //console.log("source resource sync count: ", resourceSyncCount[source_resource_id], source_resource_id);

                            const shipping = Object.keys(resourceSyncCount[source_resource_id]);
                            if(task.nice && shipping.length > 4) {
                                task.status_msg = `source resource(${source_resource.name}) is busy shipping out other data.. waiting`;
                                task.next_date = new Date(Date.now()+1000*90);
                                return cb(); //retry
                            }

                            //let's start syncing!
                            let source_path = common.gettaskdir(dep.task.instance_id, dep.task._id, source_resource);
                            let dest_path = common.gettaskdir(dep.task.instance_id, dep.task._id, resource);
                            let msg_prefix = "Synchronizing dependent task directory from "+source_resource.name+" to "+resource.name+". "+(dep.task.desc||dep.task.name||dep.task._id.toString());
                            task.status_msg = msg_prefix;
                            let saving_progress = false;
                            task.save(err=>{
                                resourceSyncCount[source_resource_id][task.id] = new Date();

                                console.debug("-- resourceSyncCount source_resource_id: ", source_resource_id, "----");
                                console.log(JSON.stringify(resourceSyncCount[source_resource_id], null, 4));

                                _transfer.rsync_resource(source_resource, resource, source_path, dest_path, dep.subdirs, progress=>{
                                    task.status_msg = msg_prefix+" "+progress;
                                    saving_progress = true;
                                    task.save(()=>{
                                        saving_progress = false;
                                    }); 
                                }, err=>{
                                    delete resourceSyncCount[source_resource_id][task._id];

                                    if(err) {
                                        //failed to rsync.. let's fail the job 
                                        return cb(err);
                                    }
                                    
                                    //I have to wait to make sure task.save() in progress finish writing - before moving to
                                    //the next step - which may run task.save() immediately which causes
                                    //"ParallelSaveError: Can't save() the same doc multiple times in parallel. "
                                    function wait_progress_save() {
                                        if(saving_progress) {
                                            console.error("waiting for progress task.save()");
                                            return setTimeout(wait_progress_save, 500);
                                        }

                                        if(err) {
                                            task.status_msg = "Failed to synchronize dependent task directories.. "+err.toString();
                                            next_source(); 
                                        } else {
                                            //success! let's records new resource_ids and proceed to the next dep
                                            //only if length is not set (copy all mode). if we are doing partial syncing, we don't want to mark it on database as full copy
                                            if(dep.subdirs && dep.subdirs.length) {
                                                console.debug("partial synced");
                                                return next_dep();
                                            }

                                            console.debug("adding new resource_id (could cause same doc in parallel error? :%s", resource._id.toString());
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
                            console.log("syncing failed.. but we were able to sync before.. proceeding to next dep");
                            return next_dep();
                        }

                        task.status_msg = "Couldn't sync dep task from any resources.. will try later";
                        cb();  //retry
                    });

                }, next);
            },
    
            //query current github commit id
            next=>{
                _service.get_sha(service, task.service_branch, (err, ref)=>{
                    if(err) {
                        console.error("failed to obtain commit id from github.. maybe service/branch no longer exists?");
                        console.error(err);
                        //return next(err); //can't convert to string?
                        return next("failed to get commit id from github. Did service/branch name change?");
                    }
                    if(!ref) {
                        console.error("failed to obtain sha from github")
                        console.error(ref);
                        return next("failed to get sha of app from githb.")
                    }
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
                    cache_app(conn, service, task.service_branch, workdir, taskdir, task.commit_id, (err, app_cache)=>{
                        if(err) return next(err);
                        if(!app_cache) {
                            //TODO - not working?
                            task.next_date = new Date(Date.now()+1000*300);
                            task.status_msg = "Waiting for the App to be installed (5mins)";
                            return cb(); //retry
                        }
                        
                        //TODO - this doesn't copy hidden files (like .gitignore).. it's okay?
                        console.debug("mkdir/rsync appcache, etc..");
                        conn.exec("timeout 10 mkdir -p "+taskdir+" && timeout 120 rsync -a "+app_cache+"/ "+taskdir, (err, stream)=>{
                            if(err) return next(err);
                            stream.on('close', (code, signal)=>{
                                if(code === undefined) return next("connection terminated while creating taskdir");
                                if(code != 0) return next("failed to create taskdir.. code:"+code)
                                console.debug("taskdir created");
                                next();
                            })
                            .on('data', function(data) {
                                //console.log(data.toString());
                            }).stderr.on('data', function(data) {
                                console.error(data.toString());
                            });
                        });

                    });
                });
            },

            //this is really warehouse specific behavior, but I can't think of a better way
            //load taskproduct for each deps_config
            next=>{
                if(!task.deps_config) return next(); //no deps then skip
                if(!task.config || !task.config._inputs) return next(); 
                const ids = task.deps_config.map(t=>t.task.id);
                console.log("loading taskproduct", ids);
                db.Taskproduct.find({task_id: {$in: ids}}).then(products=>{
                    //merge product info to config inputs
                    //console.log(JSON.stringify(products, null, 4));
                    task.config._inputs.forEach(input=>{
                        const product = products.find(p=>p.task_id == input.task_id);
                        if(!product) return;
                        if(!product.product) return; //TODO why does this happen?
                        //console.log("handling", input, product.product);

                        if(!input.meta) input.meta = {};
                        if(!input.tags) input.tags = [];
                        if(!input.datatype_tags) input.datatype_tags = [];

                        //apply product root content (for all inputs)
                        const root = product.product;
                        if(root.meta) Object.assign(input.meta, root.meta);
                        if(root.tags) input.tags = Array.from(new Set([...input.tags, ...root.tags]));
                        if(root.datatype_tags) input.datatype_tags = Array.from(new Set([...input.datatype_tags, ...root.datatype_tags]));

                        //apply output specific content
                        const p = root[input.subdir];
                        if(!p) return;
                        if(p.meta) Object.assign(input.meta, p.meta);
                        if(p.tags) input.tags = Array.from(new Set([...input.tags, ...p.tags]));
                        if(p.datatype_tags) input.datatype_tags = 
                            Array.from(new Set([...input.datatype_tags, ...p.datatype_tags]));
                        input._productMerged = true;
                        //console.log("megedd", p, input);
                    });
                    next();
                });
            },
            
            //install config.json in the taskdir
            next=>{
                if(!task.config) {
                    console.log("no config object stored in task.. skipping writing config.json");
                    return next();
                }

                common.get_ssh_connection(resource, (err, conn)=>{
                    if(err) return next(err);
                    console.log("installing config.json");
                    conn.exec("timeout 15 cat > "+taskdir+"/config.json", function(err, stream) {
                        if(err) return next(err);
                        //common.set_conn_timeout(conn, stream, 1000*5);
                        stream.on('close', function(code, signal) {
                            if(code === undefined) return next("connection terminated while installing config.json");
                            else if(code) return next("Failed to write config.json -- code:"+code);
                            else next();
                        })
                        .on('data', function(data) {
                            console.log(data.toString());
                        }).stderr.on('data', function(data) {
                            console.log(data.toString());
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
                    conn.exec("timeout 15 bash -c \"cd "+taskdir+" && cat > _env.sh && chmod +x _env.sh\"", function(err, stream) {
                        if(err) return next(err);
                        stream.on('close', function(code, signal) {
                            if(code === undefined) return next("connection terminated while installing _env.sh");
                            else if(code) return next("Failed to write _env.sh -- code:"+code);
                            else next();
                        })
                        .on('data', function(data) {
                            console.log(data.toString());
                        }).stderr.on('data', function(data) {
                            console.error(data.toString());
                        });
                        stream.write("#!/bin/bash\n");

                        //write some debugging info
                        stream.write("# task id        : "+task._id.toString()+" (run "+(task.run+1)+")\n");
                        var username = resource.config.username;//||resource_detail.username);
                        var hostname = resource.config.hostname;//||resource_detail.hostname);
                        stream.write("# resource       : "+resource.name+"\n"); //+" ("+resource_detail.name+")\n");
                        stream.write("#                : "+username+"@"+hostname+"\n");
                        stream.write("# task dir       : "+taskdir+"\n");
                        if(task.remove_date) stream.write("# remove_date    : "+task.remove_date+"\n");

                        //write ENVs
                        for(var k in envs) {
                            var v = envs[k];
                            //let's make sure we have primitive types
                            if(typeof v == 'object') {
                                v = "_ignoring_";
                            }
                            v = v.toString();

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

            //finally, run the service!
            next=>{
                if(service_detail.run) return next(); //some app uses run instead of start .. run takes precedence
                console.debug("starting service: "+taskdir+"/"+service_detail.start);

                //save status since it might take a while to start
                task.status_msg = "Starting service";
                task.save(function(err) {
                    if(err) return next(err);
                    //BigRed2 seems to have AcceptEnv disabled in sshd_config - so I can't pass env via exec
                    common.get_ssh_connection(resource, (err, conn)=>{
                        if(err) return next(err);
                        conn.exec("timeout 45 bash -c \"cd "+taskdir+" && source _env.sh && "+service_detail.start+" >> start.log 2>&1\"", (err, stream)=>{
                            if(err) return next(err);
                            //common.set_conn_timeout(conn, stream, 1000*20);
                            stream.on('close', function(code, signal) {
                                if(code === undefined) return next("connection terminated while starting task");
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
                                console.log(data.toString());
                            });
                            stream.stderr.on('data', function(data) {
                                console.log(data.toString());
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

                console.log("running_sync service (deprecate!): "+taskdir+"/"+service_detail.run);

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
                        conn.exec("timeout 90 bash -c \"cd "+taskdir+" && source _env.sh && "+service_detail.run+" > run.log 2>&1\"", (err, stream)=>{
                            if(err) return next(err);
                            
                            //20 seconds too short to validate large dwi by validator-neuro-track
                            //TODO - I should really make validator-neuro-track asynchronous
                            //common.set_conn_timeout(conn, stream, 1000*60); 

                            stream.on('close', function(code, signal) {
                                if(code === undefined) next("connection terminated while running_sync");
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
                                console.log(data.toString());
                            }).stderr.on('data', function(data) {
                                console.log(data.toString());
                            });
                        });
                    });
                });
            },
            //done with all steps!
        ], (err, results)=>{
            cb(err);
        });
    });
}

//TODO - I am not sure zip download from github includes lfs content?
//returns (err, app_cache) app_cache will be set to false if other jobs 
//seems to be staging the same cache
function cache_app(conn, service, branch, workdir, taskdir, commit_id, cb) {
    let app_cache = workdir+"/appcache/"+service.split("/")[1]+"-"+commit_id;

    async.series([

        //make sure appcache parent directory exists
        next=>{
            let app_cache_dir = path.dirname(app_cache);
            conn.exec("timeout 30 mkdir -p "+app_cache_dir, (err, stream)=>{
                if(err) return next(err);
                stream.on('close', (code, signal)=>{
                    if(code === undefined) return next("connection terminated while creating appcache directory");
                    else if(code == 0) {
                        return next();
                    } else next("failed to create appcache directory");
                })
                .on('data', function(data) {
                    console.log(data.toString());
                });
            });
        },
        
        //see if app cache directory is not empty (purged?)
        //TODO - what was the point of this?
        next=>{
            conn.exec("timeout 30 find "+app_cache+" -depth -empty -delete", (err, stream)=>{
                if(err) return next(err);
                stream.on('close', (code, signal)=>{
                    if(code === undefined) return next("connection terminated while removing empty app cache directory");
                    if(code == 1) return next(); //no such directory
                    if(code != 0) return next("failed to (try) removing empty directory");
                    //if code == 0, then that means it was not empty, or it was empty and successfully removed
                    next(); 
                })
                .on('data', data=>{
                    console.log(data.toString());
                });
            });
        },

        //see if app is cached already
        next=>{
            //console.debug("checking app_cache %s", app_cache);
            conn.exec("timeout 30 ls "+app_cache, (err, stream)=>{
                if(err) return next(err);
                stream.on('close', (code, signal)=>{
                    if(code === undefined) return next("connection terminated while checking app_cache");
                    else if(code == 0) {
                        console.debug("app cache exists");
                        return cb(null, app_cache);
                    } else console.debug("no app cache");
                    next();
                })
                .on('data', function(data) {
                    //too verbose..
                    //console.log(data.toString());
                });
            });
        },

        //check to see if other process is already downloading a cache
        next=>{
            conn.exec("timeout 30 stat --printf=\"%Y\" "+app_cache+".clone", (err, stream)=>{
                if(err) return next(err);
                let mod_s = "";
                stream.on('close', (code, signal)=>{
                    if(code === undefined) return next("connection terminated while checking app cache .clone");
                    else if(code == 0) {
                        let age = new Date().getTime()/1000 - mod_s;
                        console.log("app cache .clone exists.. mod time: %s age:%d(secs)", mod_s, age);
                        if(age < 60) {
                            console.debug("will wait..");
                            return cb(null, false); //retry later.. maybe it's still getting downloaded
                        }
                        console.log("but it's too old.. will override..");
                        next(); //proceed and overwrite..
                    } else {
                        console.debug("nobody is cloning app.. proceeding with clone. code:"+code);
                        //TODO - it could happen that other download has just began.. might need to do flock?
                        next();
                    }
                })
                .on('data', function(data) {
                    console.log(data.toString());
                    mod_s += data.toString();
                }).stderr.on('data', function(data) {
                    //might say .clone doesn't exist, but that's a good thing
                    //console.error(data.toString());
                });
            });
        },

        //cache app and unzip, and unwind
        next=>{
            console.log("caching app %s", app_cache+".clone");
            const branchOpt = branch?("--branch "+branch):"";
            let stdout = "";
            let stderr = "";
            conn.exec("timeout 60 "+ 
                "rm -rf "+app_cache+".clone && "+ 
                "git clone --recurse-submodules --depth=1 "+branchOpt+" https://"+config.github.access_token+"@github.com/"+service+" "+app_cache+".clone && "+
                "mv "+app_cache+".clone "+app_cache, (err, stream)=>{
                if(err) return next(err);
                stream.on('close', function(code, signal) {
                    //TODO - should I remove the partially downloaded zip?
                    if(code === undefined) return next("connection terminated while caching app");
                    else if(code) {
                        return next("failed to cache app .. code:"+code+"\n"+stderr);
                    } else {
                        console.debug("successfully cached app");
                        next();
                    }
                })
                .on('data', function(data) {
                    console.log(data.toString());
                    stdout+=data.toString()
                }).stderr.on('data', function(data) {
                    console.error(data.toString());
                    stderr+=data.toString()
                });
            });
        },
    ], err=>{
        cb(err, app_cache);
    });
}

function load_product(taskdir, resource, cb) {
    console.debug("loading "+taskdir+"/product.json");
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
                if(code) return cb("Failed to retrieve product.json from the task directory - code:"+code);
                if(error_msg) {
                    console.log("Failed to load product.json (continuing)");
                    console.log(error_msg);
                    return cb();
                }
                if(product_json.length > 1024*1024) return cb("product.json is too big.. 1MB max (should be around a few kilobytes)");

                try {
                    //NaN is not a valid JSON, but python.dumps() allows it by default.
                    /*
                    //instead of forcing all client to do the right thing.. let's handle it
                    var product = JSON.parse(product_json.replace(/\bNaN\b/g, '"***NaN***"'), (key, value)=>{
                        return value === "***NaN***" ? NaN : value;
                    });
                    */
                    var product = JSON.parse(product_json.replace(/\bNaN\b/g, "null"));

                    console.log("successfully loaded product.json");
                    cb(null, product);
                } catch(e) {
                    console.error("Failed to parse product.json (ignoring): "+e.toString());
                    cb();
                }
            });
        });
    });
}

//TODO - this is more of a warehouse behavior?
async function storeProduct(task, dirty_product) {
    product = common.escape_dot(dirty_product);

    //for validation task, I need to merge product from the main task 
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
    if(!product) return;

    await db.Taskproduct.findOneAndUpdate({task_id: task._id}, {product}, {upsert: true});
}

//counter to keep up with how many checks are performed in the last few minutes
let _counts = {
    checks: 0,
    tasks: 0,
}

let low_check = 0;
let serviceStarted = new Date();

function health_check() {

    var ssh = common.report_ssh();
    var report = {
        status: "ok",
        version: pkg.version,
        ssh,
        messages: [],
        date: new Date(),
        startDate: serviceStarted,
        counts: _counts,
        maxage: 1000*240,
        nonice: argv.nonice,
    }

    async.series([
        
        //check counters
        next=>{
            if(ssh.ssh_cons > 120) {
                report.status = "failed";
                report.messages.push("high ssh connections "+ssh.ssh_cons);
            }
            if(ssh.sftp_cons > 60) {
                report.status = "failed";
                report.messages.push("high sftp connections "+ssh.sftp_cons);
            }

            next();
        },

        //check task handling queue
        next=>{
            const query = {
                status: {$ne: "removed"}, //ignore removed tasks
                $or: [
                    {next_date: {$exists: false}},
                    {next_date: {$lt: new Date()}}
                ]
            };
            if(argv.nonice) query.nice = {$exists: false};
            else query.nice = {$exists: true};

            db.Task.count(query).exec((err, count)=>{
                if(err) return next(err);
                report.queue_size = count;
                if(count > 2000) {
                    report.status = "failed";
                    report.messages.push("high task queue count "+count);
                }
                next();
            });
        },

    ], err=>{
        if(err) return console.error(err);
        
        //dump report
        console.debug(new Date());
        console.debug(JSON.stringify(report, null, 4));

        //send report
        rcon.set("health.amaretti.task."+process.env.HOSTNAME+"-"+process.pid, JSON.stringify(report));

        if(report.queue_size > 0 && _counts.checks == 0) {
            console.error("not checking anymore.. the loop died? killing.");
            process.exit(1);
        }

        //reset counter
        _counts.checks = 0;
        _counts.tasks = 0;
        
    });
}

var rcon = redis.createClient(config.redis.port, config.redis.server);
rcon.on('error', err=>{throw err});
rcon.on('ready', ()=>{
    console.log("staring health check");
    setInterval(health_check, 1000*120);
});

