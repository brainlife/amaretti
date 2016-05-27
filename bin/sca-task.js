#!/usr/bin/node
'use strict';

//node
var fs = require('fs');
var path = require('path');
var os = require('os');

//contrib
var winston = require('winston');
var async = require('async');
var Client = require('ssh2').Client;

//mine
var config = require('../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../api/models/db');
var common = require('../api/common');
var resource_picker = require('../api/resource_picker');
var transfer = require('../api/transfer');

db.init(function(err) {
    if(err) throw err;
    check_requested();
    check_running();
    check_stop();
    check_stuck();
});

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
        setTimeout(check_stuck, 1000*60);
    });
} 

//var running = 0;
function check_requested() {
    /*
    if(running > config.task_handler.concurrency) {
        logger.info("running too many tasks already.. skipping this round");
        return;
    }
    */

    //look for requested task that doesn't have _handled set
    db.Task
    .find({status: "requested", _handled: {$exists: false}})
    .populate('deps', 'status resource_id') //populate dep tasks status and resource_id
    .populate('resource_deps')  //populate resource deps
    .exec(function(err, tasks) {
        if(err) throw err;
        logger.info("check_requested:"+tasks.length);
        
        async.eachSeries(tasks, function(task, next) {
            //console.dir(task);
            //make sure dependent tasks has all finished
            //TODO - this is extremely inefficient. maybe I should set such request to "waiting_dep" and reset them to "requested" once
            //depdendent task has finished
            var deps_all_done = true;
            var dep_failed = null;
            task.deps.forEach(function(dep) {
                if(dep.status != "finished") deps_all_done = false; 
                if(dep.status == "failed") dep_failed = dep._id;
            });
            if(dep_failed) {
                logger.debug("one of dependency has failed.. stopping this task");
                task.status = "stopped";
                task.status_msg = "Dependency: "+dep_failed+" failed.. stopping";
                task.save(next);
                return;
            }
            if(!deps_all_done) {
                logger.debug("task:"+task._id+" dependency not met.. postponing");
                return next();
            }
            
            //first of all... mark the task as _handled (so that another run won't pick this up..)
            task._handled = {hostname: os.hostname(), pid: process.pid, timestamp: new Date()}
            task.save(function(err) {
                if(err) throw err;

                //asyncly handle each request
                task._handled = undefined; //this is how you delete a key in mongoose
                process_requested(task, function(err) {
                    if(err) {
                        logger.error(err); //continue
                        task.status = "failed";
                        task.status_msg = err;
                        task.save();
                    }
                });
                
                //intentially let outside of process_requested cb
                //each request will be handled asynchronously so that I don't wait on each task to start / run before processing next taxt
                next(); 
            });
        }, function(err) {
            //wait for the next round
            setTimeout(check_requested, 1000*10);
        });
    });
}

function check_stop() {
    db.Task.find({status: "stop_requested"}).exec(function(err, tasks) {
        if(err) throw err;
        logger.info("check_stop:"+tasks.length);
        //logger.info("check_stop:: loaded "+tasks.length+" stop_requested tasks");
        async.eachSeries(tasks, function(task, next) {
            logger.info("handling stop request:"+task._id);
            db.Resource.findById(task.resource_id, function(err, resource) {
                if(err) {
                    logger.error(err);
                    return next(); //skip this task
                }

                db.Service.findOne({name: task.service}, function(err, service_detail) {
                    if(err) {
                        logger.error("Couldn't find such service:"+task.service);
                        return next(); //skip this task
                    }
                    if(!service_detail.pkg || service_detail.pkg.scripts || !service_detail.pkg.scripts.stop) {
                        logger.error("service:"+task.service+" doesn't have scripts.stop defined.. marking as finished");
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
        }, function(err) {
            if(err) logger.error(err); //continue
            //all done for this round - schedule for next
            setTimeout(check_stop, 1000*10); //check job status every few minutes
        });
    });
}

//check for task status of already running tasks
function check_running() {
    db.Task.find({status: "running"}).exec(function(err, tasks) {
        if(err) throw err;
        logger.info("check_running:"+tasks.length);
        //logger.info("check_running :: loaded "+tasks.length+" running tasks");
        //process synchronously so that I don't accidentally overwrap with next check
        async.eachSeries(tasks, function(task, next) {
            logger.info("check_running "+task._id);

            db.Resource.findById(task.resource_id, function(err, resource) {
                if(err) return next(err);
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
                                    task.save(next);
                                });
                                break;
                            case 2:  //failed
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
        }, function(err) {
            if(err) {
                logger.error(err);
            }
            
            //all done for this round - schedule for next
            setTimeout(check_running, 1000*10); //check job status every few minutes
        });
    });
}

function process_requested(task, cb) {
    resource_picker.select(task.user_id, {
        service: task.service,
        preferred_resource_id: task.preferred_resource_id //user preference (most of the time not set)
        //other_service_id: [] //TODO - provide other service_ids that resource will be asked to run along
    }, function(err, resource) {
        if(err) return cb(err);
        if(!resource) return cb("Couldn't find a resource to execute this task");
        task.resource_id = resource._id;

        common.progress(task.progress_key, {status: 'running', progress: 0, msg: 'Initializing'});
        init_task(task, resource, function(err) {
            if(err) {
                common.progress(task.progress_key, {status: 'failed', /*progress: 0,*/ msg: err.toString()});
                return cb(err);
            }
            cb();
        });
    });
}

//initialize task and run or start the service
function init_task(task, resource, cb) {
    common.get_ssh_connection(resource, function(err, conn) {
        if(err) return cb(err);
        var service = task.service;
        if(service == null) return cb(new Error("service not set.."));

        db.Service.findOne({name: service}, function(err, service_detail) {
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

            async.series([
                function(next) {
                    common.progress(task.progress_key+".prep", {name: "Task Prep", status: 'running', progress: 0.05, msg: 'Installing sca install script', weight: 0});
                    conn.exec("mkdir -p ~/.sca && cat > ~/.sca/install.sh && chmod +x ~/.sca/install.sh", function(err, stream) {
                        if(err) next(err);
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
                        if(err) next(err);
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
                    /*
                    var url = service_detail.repository.url;
                    //trim "git+" from git+https
                    if(url.indexOf("git+https://") == 0) {
                        url = url.substring(4);
                    }
                    */
                    var repo_owner = service.split("/")[0];
                    //logger.debug("ls .sca/services/"+service+ " >/dev/null 2>&1 || mkdir -p .sca/services/"+repo_owner+" && LD_LIBRARY_PATH=\"\" git clone "+service_detail.git.clone_url+" .sca/services/"+service);
                    conn.exec("ls .sca/services/"+service+ " >/dev/null 2>&1 || (mkdir -p .sca/services/"+repo_owner+" && LD_LIBRARY_PATH=\"\" git clone "+service_detail.git.clone_url+" .sca/services/"+service+")", function(err, stream) {
                        if(err) next(err);
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
                        if(err) next(err);
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
                
                /* can't get this thing to work..
                //run service install.sh (if used)
                //TODO - once installed file gets created, install.sh will never run..
                //to reduce the confusion, I am 60% leaning toward not having install.sh and let service owner do any install step during start.sh or run.sh
                function(next) {
                    if(!service_detail.pkg.scripts.install) return next(); 
                    conn.exec("ls .sca/services/"+service+ "/installed >/dev/null 2>&1 || cd .sca/services/"+service+"; ./install.sh && echo $! > installed", function(err, stream) {
                        if(err) next(err);
                        stream.on('close', function(code, signal) {
                            if(code) return next("Failed to run install.sh:"+code);
                            else next();
                        })
                        .on('data', function(data) {
                            logger.info(data.toString());
                        }).stderr.on('data', function(data) {
                            logger.error(data.toString());
                        });
                    });
                },
                */

                function(next) {
                    common.progress(task.progress_key+".prep", {progress: 0.7, msg: 'Preparing taskdir'});
                    logger.debug("making sure taskdir("+taskdir+") exists");
                    conn.exec("mkdir -p "+taskdir, function(err, stream) {
                        if(err) next(err);
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
                        if(resource.user_id != task.user_id) return next_dep("resource dep aren't owned by the same user");
                        logger.info("storing resource key for "+resource._id+" as requested");
                        common.decrypt_resource(resource);

                        //now handle things according to the resource type
                        switch(resource.type) {
                        case "hpss": 
                            //envs.HPSS_PRINCIPAL = resource.config.username;
                            //envs.HPSS_AUTH_METHOD = resource.config.auth_method;
                            //envs.HPSS_KEYTAB_PATH = "$HOME/.sca/keys/"+resource._id+".keytab";

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
                            if(source_resource.user_id != task.user_id) return next_dep("dep resource aren't owned by the same user");
                            var source_path = common.gettaskdir(task.instance_id, dep._id, source_resource);
                            var dest_path = common.gettaskdir(task.instance_id, dep._id, resource);
                            logger.debug("syncing from source:"+source_path);
                            logger.debug("syncing from dest:"+dest_path);
                            //TODO - how can I prevent 2 different tasks from trying to rsync at the same time?
                            common.progress(task.progress_key+".sync", {status: 'running', progress: 0, weight: 0, name: 'Transferring source task directory'});
                            transfer.rsync_resource(source_resource, resource, source_path, dest_path, function(err) {
                                if(err) common.progress(task.progress_key+".sync", {status: 'failed', msg: err.toString()});
                                else common.progress(task.progress_key+".sync", {status: 'finished', msg: "Successfully synced", progress: 1});
                                next_dep(err);
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
                        if(err) next(err);
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
                        if(err) next(err);
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
                        if(err) next(err);
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
                        console.dir(service_detail.pkg.scripts);
                        return next("pkg.scripts.run nor pkg.scripts.start defined in package.json"); 
                    }
                    
                    //common.progress(task.progress_key+".prep", {status: 'running', progress: 0.6, msg: 'Installing config.json'});
                    logger.debug("installing _boot.sh");
                    conn.exec("cd "+taskdir+" && cat > _boot.sh && chmod +x _boot.sh", function(err, stream) {
                        if(err) next(err);
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

                    conn.exec("cd "+taskdir+" && ./_boot.sh > start.log 2>&1", {
                        /* BigRed2 seems to have AcceptEnv disabled in sshd_config - so I can't use env: { SCA_SOMETHING: 'whatever', }*/
                    }, function(err, stream) {
                        if(err) next(err);
                        stream.on('close', function(code, signal) {
                            if(code) {
                                return next("Service startup failed with return code:"+code+" signal:"+signal);
                            } else {
                                task.status = "running";
                                task.status_msg = "Started service";
                                task.start_date = new Date();
                                task.save(next);
                            }
                        })
                        .on('data', function(data) {
                            logger.info(data.toString());
                        }).stderr.on('data', function(data) {
                            logger.error(data.toString());
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
                        conn.exec("cd "+taskdir+" && ./_boot.sh > run.log 2>&1", {
                            /* BigRed2 seems to have AcceptEnv disabled in sshd_config - so I can't use env: { SCA_SOMETHING: 'whatever', }*/
                        }, function(err, stream) {
                            if(err) next(err);
                            stream.on('close', function(code, signal) {
                                if(code) {
                                    return next("Service failed with return code:"+code+" signal:"+signal);
                                } else {
                                    load_products(task, taskdir, conn, function(err) {
                                        if(err) return next(err);
                                        common.progress(task.progress_key, {status: 'finished', /*progress: 1,*/ msg: 'Service Completed'});
                                        task.status = "finished"; 
                                        task.status_msg = "Service ran successfully";
                                        task.finish_date = new Date();
                                        task.save(next);
                                    });
                                }
                            })
                            .on('data', function(data) {
                                logger.info(data.toString());
                            }).stderr.on('data', function(data) {
                                logger.error(data.toString());
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


