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
});

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
    .find({status: "requested",  _handled: {$exists: false}})
    .populate('deps', 'status resource_id') //populate dep status and resource_id
    .exec(function(err, tasks) {
        if(err) throw err;
        logger.info("check_requested :: loaded "+tasks.length);
        
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
                task.status_msg = "dependency: "+dep_failed+" failed.. stopping";
                task.save(next);
                return;
            }
            if(!deps_all_done) {
                logger.debug("dependency not met.. postponing");
                return next();
            }
            
            //first of all... mark the task as _handled
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
        //logger.info("check_stop:: loaded "+tasks.length+" stop_requested tasks");
        async.eachSeries(tasks, function(task, next) {
            logger.info("handling stop request:"+task._id);
            db.Resource.findById(task.resource_id, function(err, resource) {
                if(err) {
                    logger.error(err);
                    return next(); //skip this task
                }

                var service_detail = config.services[task.service_id];
                if(!service_detail) {
                    logger.error("Couldn't find such service:"+task.service_id);
                    return next(); //skip this task
                }
                if(!service_detail.sca || !service_detail.sca.bin || !service_detail.sca.bin.stop) {
                    logger.error("service:"+task.service_id+" doesn't have stop.sh defined.. marking as finished");
                    task.status = "stopped";
                    task.status_msg = "Stopped by user";
                    task.save();
                    return next(); //skip this task
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
                                task.save();
                                next();
                                break;
                            default:
                                task.status_msg = "Failed to stop the task cleanly -- code:"+code;
                                task.save();
                                next();
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
        }, function(err) {
            if(err) logger.error(err); //continue
            //all done for this round - schedule for next
            setTimeout(check_running, 1000*5); //check job status every few minutes
        });
    });
}

//check for task status of already running tasks
function check_running() {
    db.Task.find({status: "running"}).exec(function(err, tasks) {
        if(err) throw err;
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
                        stream.on('close', function(code, signal) {
                            switch(code) {
                            case 0: //still running
                                next();
                                break;
                            case 1: //finished
                                load_products(task, taskdir, conn, function(err) {
                                    if(err) {
                                        task.status = "failed";
                                        task.status_msg = err;
                                        task.save();
                                        common.progress(task.progress_key, {status: 'failed', msg: err.toString()}, next);
                                        return;
                                    }
                                    task.status = "finished"; //load_products saves this
                                    task.status_msg = "service completed successfully";
                                    task.save();
                                    common.progress(task.progress_key, {status: 'finished', msg: 'Service Completed'}, next);
                                });
                                break;
                            case 2:  //failed
                                task.status = "failed"; //load_products saves this
                                task.status_msg = err;
                                task.save();
                                common.progress(task.progress_key, {status: 'failed', msg: 'Service failed'}, next);
                                break; 
                            default:
                                //TODO - should I mark it as failed? or.. 3 strikes and out rule?
                                logger.error("unknown return code:"+code+" returned from _status.sh");
                                next();
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
                logger.error(err);
            }
            
            //all done for this round - schedule for next
            setTimeout(check_running, 1000*60); //check job status every few minutes
        });
    });
}

function process_requested(task, cb) {
    //var query = null;
    //var service_detail = config.services[task.service_id];
    //if(!service_detail) return cb("Couldn't find such service:"+task.service_id);
    resource_picker.select(task.user_id, {
        service_id: task.service_id,
        //other_service_id: [] //TODO - provide other service_ids that resource will be asked to run along
    }, function(err, resource) {
        if(err) return cb(err);
        if(!resource) return cb("couldn't find a resource to execute this task");
        task.resource_id = resource._id;

        common.progress(task.progress_key, {status: 'running', /*progress: 0,*/ msg: 'Initializing'});
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
        var service_id = task.service_id;
        if(service_id == null) return cb(new Error("service_id not set.."));

        var service_detail = config.services[service_id];
        if(!service_detail) return cb("Couldn't find such service:"+service_id);
        if(!service_detail.sca || !service_detail.sca.bin) return cb("package.sca.bin not defined");

        console.log("running service:"+service_id);
        //console.dir(service_detail);
        var workdir = common.getworkdir(task.instance_id, resource);
        var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
        var envs = {
            SCA_WORKFLOW_ID: task.instance_id.toString(),
            SCA_WORKFLOW_DIR: workdir,
            SCA_TASK_ID: task._id.toString(),
            SCA_TASK_DIR: taskdir,
            SCA_SERVICE_ID: service_id,
            SCA_SERVICE_DIR: "$HOME/.sca/services/"+service_id,
            SCA_PROGRESS_URL: config.progress.api+"/status/"+task.progress_key/*+".service"*/,
        };
        task._envs = envs;

        async.series([
            function(next) {
                //common.progress(task.progress_key, {msg: "Preparing Task"});
                common.progress(task.progress_key+".prep", {name: "Task Prep", status: 'running', progress: 0.05, msg: 'Installing sca install script', weight: 0});
                /*
                logger.debug("making sure ~/.sca/services exists");
                conn.exec("mkdir -p .sca/services", function(err, stream) {
                    if(err) next(err);
                    stream.on('close', function(code, signal) {
                        if(code) return next("Failed to create ~/.sca/services");
                        else next();
                    });
                });
                */
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
                common.progress(task.progress_key+".prep", {progress: 0.5, msg: 'Installing/updating '+service_id+' service'});
                conn.exec("ls .sca/services/"+service_id+ " >/dev/null 2>&1 || LD_LIBRARY_PATH=\"\" git clone "+service_detail.repository.url+" .sca/services/"+service_id, function(err, stream) {
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
                conn.exec("cd .sca/services/"+service_id+" && LD_LIBRARY_PATH=\"\" git pull", function(err, stream) {
                    if(err) next(err);
                    stream.on('close', function(code, signal) {
                        if(code) return next("Failed to git pull in ~/.sca/services/"+service_id);
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

            /*
            //TODO - maybe this should be handled via deps
            //process hpss resource (if exists..)
            function(next) { 
                if(!task.resources.hpss) return next();
                logger.debug("installing hpss key");
                db.Resource.findById(task.resources.hpss, function(err, resource) {
                    if(err) return next(err);
                    common.decrypt_resource(resource);
                    
                    //TODO - what if user uses nonkeytab?
                    envs.HPSS_PRINCIPAL = resource.config.username;
                    envs.HPSS_AUTH_METHOD = resource.config.auth_method;
                    envs.HPSS_KEYTAB_PATH = "$HOME/.sca/keys/"+resource._id+".keytab";

                    //now install the hpss key
                    var key_filename = ".sca/keys/"+resource._id+".keytab";
                    conn.exec("cat > "+key_filename+" && chmod 600 "+key_filename, function(err, stream) {
                        if(err) next(err);
                        stream.on('close', function(code, signal) {
                            if(code) return next("Failed write https keytab");
                            else next();
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
                });
            },
            */

            //make sure dep task dirs are synced 
            function(next) {
                if(!task.deps) return next(); //skip
                async.forEach(task.deps, function(dep, next_dep) {
                    //if resource is the same, don't need to sync
                    if(task.resource_id == dep.resource_id) return next_dep();
                    db.Resource.findById(dep.resource_id, function(err, source_resource) {
                        if(err) return cb(err);
                        if(!source_resource) return cb("couldn't find dep resource");
                        if(source_resource.user_id != task.user_id) return cb("dep resource aren't owned by the same user");
                        var source_path = common.gettaskdir(task.instance_id, task._id, source_resource);
                        var dest_path = common.gettaskdir(task.instance_id, task._id, resource);
                        //TODO - how can I prevent 2 different tasks from trying to rsync at the same time?
                        common.progress(task.progress_key+".sync", {status: 'running', progress: 0, name: 'Transferring source task directory'});
                        transfer.rsync_resource(source_resource, resource, source_path, dest_path, function(err) {
                            if(err) common.progress(task.progress_key+".sync", {status: 'failed', msg: err.toString()});
                            else common.progress(task.progress_key+".sync", {status: 'finished', progress: 1});
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
                if(!service_detail.sca.bin.status) return next(); 

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
                    stream.write("~/.sca/services/"+service_id+"/"+service_detail.sca.bin.status);
                    stream.end();
                });
            },
            
            //write _stop.sh
            function(next) { 
                //not all service has stop
                if(!service_detail.sca.bin.stop) return next(); 

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
                    stream.write("~/.sca/services/"+service_id+"/"+service_detail.sca.bin.stop);
                    stream.end();
                });
            },
 
            //write _boot.sh
            function(next) { 
                if(!service_detail.sca.bin.run && !service_detail.sca.bin.start) {
                    return next("bin.run nor bin.start defined in package.json"); 
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
                    stream.write("~/.sca/services/"+service_id+"/"+(service_detail.sca.bin.run||service_detail.sca.bin.start)+" > log.stdout 2>log.stderr\n");
                    stream.end();
                });
            },

            //end of prep
            function(next) {
                common.progress(task.progress_key+".prep", {status: 'finished', progress: 1, msg: 'Finished preparing for task'}, next);
            },
            
            //finally, start the service
            function(next) {
                if(!service_detail.sca.bin.start) return next(); //not all service uses start

                logger.debug("starting service: ~/.sca/services/"+service_id+"/"+service_detail.sca.bin.start);
                common.progress(task.progress_key/*+".service"*/, {name: service_detail.label, msg: 'Starting Service'});

                conn.exec("cd "+taskdir+" && ./_boot.sh", {
                    /* BigRed2 seems to have AcceptEnv disabled in sshd_config - so I can't use env: { SCA_SOMETHING: 'whatever', }*/
                }, function(err, stream) {
                    if(err) next(err);
                    stream.on('close', function(code, signal) {
                        if(code) {
                            return next("Service startup failed with return code:"+code+" signal:"+signal);
                        } else {
                            task.status = "running";
                            task.status_msg = "started service.";
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
                if(!service_detail.sca.bin.run) return next(); //not all service uses run (they may use start/status)

                logger.debug("running_sync service: ~/.sca/services/"+service_id+"/"+service_detail.sca.bin.run);
                common.progress(task.progress_key/*+".service"*/, {name: service_detail.label, status: 'running', /*progress: 0,*/ msg: 'Running Service'});

                task.status = "running_sync"; //mainly so that client knows what this task is doing (unnecessary?)
                task.status_msg = "running service synchrnounsly.";
                task.save(function() {
                    conn.exec("cd "+taskdir+" && ./_boot.sh", {
                        /* BigRed2 seems to have AcceptEnv disabled in sshd_config - so I can't use env: { SCA_SOMETHING: 'whatever', }*/
                    }, function(err, stream) {
                        if(err) next(err);
                        stream.on('close', function(code, signal) {
                            if(code) {
                                return next("Service failed with return code:"+code+" signal:"+signal);
                            } else {
                                load_products(task, taskdir, conn, function(err) {
                                    if(err) return next(err);
                                    task.status = "finished"; //let load_products save this
                                    task.status_msg = "service finished";
                                    task.save();
                                    common.progress(task.progress_key, {status: 'finished', /*progress: 1,*/ msg: 'Service Completed'}, next);
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
    /*
    conn.on('error', cb);
    conn.on('end', function() {
        //client disconnected.. should I reconnect?
        logger.debug("ssh2 connection ended");
    });
    var resource_detail = config.resources[resource.resource_id];
    common.decrypt_resource(resource);
    conn.connect({
        host: resource_detail.hostname,
        username: resource.config.username,
        privateKey: resource.config.enc_ssh_private,
    });
    */
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
        /*
        stream.stderr.on('data', function(data) {
            logger.error(data.toString());
        });
        */
        stream.on('close', function(code, signal) {
            if(code) return cb("Failed to retrieve products.json from the task directory");
            if(error_msg) return cb(error_msg);
            try {
                console.log(products_json);
                task.products = JSON.parse(products_json);
                task.save(cb);
            } catch(e) {
                cb("Failed to parse products.json: "+e.toString());
            }
        });
    });
}

/*
function process_product_dep(task, dep, conn, resource, envs, cb) {
    logger.debug("handling dependency");
    logger.debug(dep);

    db.Task.findById(dep.task_id).exec(function(err, dep_task) {
        if(err) throw err;
        if(!dep_task) return cb("can't find dependency task:"+dep.task_id);
        if(dep_task.user_id != task.user_id) return cb("user_id doesn't match");

        var dep_taskdir = common.gettaskdir(dep_task.instance_id, dep_task._id, resource);

        //TODO - maybe I should store this in config.<dep.name>.json?
        envs["SCA_TASK_DIR_"+dep.name] = dep_taskdir;
        envs["SCA_PRODUCT_IDX_"+dep.name] = dep.product_idx;
        
        //if on the same resource, assume that it's there
        if(resource._id == dep_task.resources.compute) return cb();
        //always rsync for cross-resource dependency - it might not be synced yet, or out-of-sync
        db.Resource.findById(dep_task.resources.compute, function(err, source_resource) {
            if(err) return cb(err);
            if(!source_resource) return cb("couldn't find dep resource");
            if(source_resource.user_id != task.user_id) return cb("dep resource user_id doesn't match");
            common.decrypt_resource(source_resource);
            var source_taskdir = common.gettaskdir(dep_task.instance_id, dep_task._id, source_resource);
            rsync_product(conn, source_resource, source_taskdir, dep_taskdir, cb);
        });
    });
}
*/


