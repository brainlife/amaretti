#!/usr/bin/node
'use strict';

//node
var fs = require('fs');
var path = require('path');

//contrib
var winston = require('winston');
var async = require('async');
var Client = require('ssh2').Client;

//mine
var config = require('./config');
var logger = new winston.Logger(config.logger.winston);
var db = require('./models/db');
var progress = require('./progress');
var common = require('./common');

db.init(function(err) {
    if(err) return cb(err);
    check_requested();
    check_running();
});

//var running = 0;
function check_requested() {
    /*
    if(running > config.task_handler.concurrency) {
        logger.info("running too many tasks already.. skipping this round");
        return;
    }
    */
    db.Task.find({status: "requested"}).exec(function(err, tasks) {
        if(err) throw err;
        //logger.info("check_requested :: loaded "+tasks.length+" requested tasks -- running:"+running);
        logger.info("check_requested :: loaded "+tasks.length);
        //process synchronously so that I don't accidentally overwrap with next check
        async.eachSeries(tasks, function(task, next) {
            task.status = "initializing";
            task.save(function(err) {
                if(err) logger.error(err); //continue
                logger.info("check_requested "+task._id);
                //but, each request will be handled asynchronously so that I don't wait on each task to start / run before processing next taxt
                process_requested(task, function(err) {
                    if(err) logger.error(err); //continue
                });
                next(); //intentially let outside of process_requested cb
            });
        }, function(err) {
            //wait for the next round
            setTimeout(check_requested, 1000*10);
        });
    });
}

//check for task status of running tasks
function check_running() {
    db.Task.find({status: "running"}).exec(function(err, tasks) {
        if(err) throw err;
        logger.info("check_running :: loaded "+tasks.length+" running tasks");
        //process synchronously so that I don't accidentally overwrap with next check
        async.eachSeries(tasks, function(task, next) {
            logger.info("check_running "+task._id);
            
            //load the compute resource and decrypt
            db.Resource.findById(task.resources.compute, function(err, resource) {
                if(err) return failed(task, err, cb);
                common.decrypt_resource(resource);
                
                //now ssh
                var conn = new Client();
                conn.on('ready', function() {
                    //var workdir = common.getworkdir(task.workflow_id, resource);
                    var taskdir = common.gettaskdir(task.workflow_id, task._id, resource);
                    conn.exec("cd "+taskdir+" && ./_status.sh", {}, function(err, stream) {
                        if(err) {
                            conn.end();
                            next(err);
                        }
                        stream.on('close', function(code, signal) {
                            switch(code) {
                            case 0: 
                                task.status = "running";
                                task.save();
                                conn.end();
                                next();
                                break;
                            case 1: 
                                task.status = "finished"; //load_products saves this
                                load_products(task, taskdir, conn, function(err) {
                                    conn.end(); //should close ssh2 connection no matter what
                                    if(err) return next(err);
                                    progress.update(task.progress_key, {status: 'finished', msg: 'Service Completed'}, next);
                                });
                                break;
                            case 2: 
                                task.status = "failed";
                                task.save();
                                conn.end();
                                progress.update(task.progress_key, {status: 'failed', msg: 'Service failed'}, next);
                                break; 
                            default:
                                //TODO - should I mark it as failed? or.. 3 strikes and out rule?
                                logger.error("unknown return code:"+code+" returned from _status.sh");
                                conn.end();
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
                var detail = config.resources[resource.resource_id];
                //console.dir(detail);
                conn.connect({
                    host: detail.hostname,
                    username: resource.config.username,
                    privateKey: resource.config.enc_ssh_private,
                });
            });
        }, function(err) {
            if(err) logger.error(err);
            //all done for this round
            setTimeout(check_running, 1000*60); //check job status every few minutes
        });
    });
}

function failed(task, error, cb) {
    //mark task as failed so that it won't be picked up again
    progress.update(task.progress_key, {status: 'failed', msg: error.toString()});
    task.status = "failed";
    //task.updated = new Date();
    task.save(function() {
        cb(error); //return task error.
    });
}

//maybe I should inline this in check_requested.
function process_requested(task, cb) {
    //first, load the compute resource and decrypt
    db.Resource.findById(task.resources.compute, function(err, resource) {
        if(err) return failed(task, err, cb);
        common.decrypt_resource(resource);
        progress.update(task.progress_key, {status: 'running', progress: 0, msg: 'Initializing'});
        init_task(task, resource, function(err) {
            if(err) return failed(task, err, cb);
            cb();
            //progress.update(task.progress_key, {status: 'finished', /*progress: 1,*/ msg: 'Task Completed'}, cb);
        });
    });
}

//initialize task and run or start the service
function init_task(task, resource, cb) {

    var detail = config.resources[resource.resource_id];
    console.dir(detail);

    var conn = new Client();
    conn.on('ready', function() {
        var service_id = task.service_id;
        if(service_id == null) return cb(new Error("service_id not set.."));

        var service_detail = config.services[service_id];
        if(!service_detail) return cb("Couldn't find such service:"+service_id);
        var workdir = common.getworkdir(task.workflow_id, resource);
        var taskdir = common.gettaskdir(task.workflow_id, task._id, resource);
        var envs = {
            //SCA_RESOURCE_ID: resource.resource_id, //bigred2 / karst, etc..
            SCA_WORKFLOW_ID: task.workflow_id.toString(),
            SCA_WORKFLOW_DIR: workdir,
            SCA_TASK_ID: task._id.toString(),
            SCA_TASK_DIR: taskdir,
            SCA_SERVICE_ID: service_id,
            SCA_SERVICE_DIR: "$HOME/.sca/services/"+service_id,
            //SCA_PROGRESS_URL: config.progress.api+"/status",
            //SCA_PROGRESS_KEY: task.progress_key+".service",
            SCA_PROGRESS_URL: config.progress.api+"/status/"+task.progress_key+".service",
        };

        async.series([
            function(next) {
                //progress.update(task.progress_key, {msg: "Preparing Task"});
                progress.update(task.progress_key+".prep", {name: "Task Prep", status: 'running', progress: 0, msg: 'installing sca install script', weight: 0});
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
                    fs.createReadStream("install/install.sh").pipe(stream);
                    //stream.write();
                    //stream.end();
                });
            },
            function(next) {
                progress.update(task.progress_key+".prep", {progress: 0.3, msg: 'running sca install script (might take a while for the first time)'});
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
                progress.update(task.progress_key+".prep", {progress: 0.5, msg: 'installing/updating '+service_id+' service'});
                //logger.debug("git clone "+service_detail.giturl+" .sca/services/"+service_id);
                conn.exec("ls .sca/services/"+service_id+ " || git clone "+service_detail.giturl+" .sca/services/"+service_id, function(err, stream) {
                    if(err) next(err);
                    stream.on('close', function(code, signal) {
                        if(code) return next("Failed to git clone "+service_detail.giturl+" code:"+code);
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
                conn.exec("cd .sca/services/"+service_id+" && git pull", function(err, stream) {
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
                progress.update(task.progress_key+".prep", {progress: 0.7, msg: 'Preparing taskdir'});
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

            //handle dependencies
            function(next) {
                if(!task.deps) return next(); //skip
                async.forEach(task.deps, function(dep, next_dep) {
                    progress.update(task.progress_key+".prep", {msg: 'Resolving '+dep.type+' dependency: '+dep.name});
                    switch(dep.type) {
                    case "product": 
                        process_product_dep(task, dep, conn, resource, envs, next_dep); break;
                    default: 
                        next_dep("unknown dep type:"+dep.type); 
                    }
                }, next);
            },
            
            //install config.json in the taskdir
            function(next) { 
                if(!task.config) {      
                    logger.info("no config object stored in task.. skipping writing config.json");
                    return next();
                }
                //progress.update(task.progress_key+".prep", {status: 'running', progress: 0.6, msg: 'Installing config.json'});
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
                if(!service_detail.bin.status) return next(); //not all service uses status
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
                    stream.write("~/.sca/services/"+service_id+"/"+service_detail.bin.status);
                    stream.end();
                });
            },
 
            //write _boot.sh
            function(next) { 
                //progress.update(task.progress_key+".prep", {status: 'running', progress: 0.6, msg: 'Installing config.json'});
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
                        var vs = v.replace(/\"/g,'\\"')
                        stream.write("export "+k+"=\""+vs+"\"\n");
                    }
                    stream.write("~/.sca/services/"+service_id+"/"+(service_detail.bin.run||service_detail.bin.start)+" > log.stdout 2>log.stderr\n");
                    stream.end();
                });
            },

            //end of prep
            function(next) {
                progress.update(task.progress_key+".prep", {status: 'finished', progress: 1, msg: 'Finished preparing for task'}, next);
            },
            
            //finally, start the service
            function(next) {
                if(!service_detail.bin.start) return next(); //not all service uses start

                logger.debug("starting service: ~/.sca/services/"+service_id+"/"+service_detail.bin.start);
                progress.update(task.progress_key+".service", {name: service_detail.label, status: 'running', progress: 0, msg: 'Starting Service'});

                conn.exec("cd "+taskdir+" && ./_boot.sh", {
                    /* BigRed2 seems to have AcceptEnv disabled in sshd_config - so I can't use env: { SCA_SOMETHING: 'whatever', }*/
                }, function(err, stream) {
                    if(err) next(err);
                    stream.on('close', function(code, signal) {
                        if(code) {
                            return next("Service startup failed with return code:"+code+" signal:"+signal);
                        } else {
                            task.status = "running";
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
                if(!service_detail.bin.run) return next(); //not all service uses run (they may use start/status)

                logger.debug("running_sync service: ~/.sca/services/"+service_id+"/"+service_detail.bin.run);
                progress.update(task.progress_key+".service", {name: service_detail.label, status: 'running', progress: 0, msg: 'Running Service'});

                task.status = "running_sync"; //mainly so that client knows what this task is doing (unnecessary?)
                task.save(function() {
                    conn.exec("cd "+taskdir+" && ./_boot.sh", {
                        /* BigRed2 seems to have AcceptEnv disabled in sshd_config - so I can't use env: { SCA_SOMETHING: 'whatever', }*/
                    }, function(err, stream) {
                        if(err) next(err);
                        stream.on('close', function(code, signal) {
                            if(code) {
                                return next("Service failed with return code:"+code+" signal:"+signal);
                            } else {
                                task.status = "finished"; //let load_products save this
                                load_products(task, taskdir, conn, function(err) {
                                    if(err) return next(err);
                                    progress.update(task.progress_key, {status: 'finished', /*progress: 1,*/ msg: 'Service Completed'}, next);
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

            /*
            //load the products.json and update task
            function(next) {
                progress.update(task.progress_key, {msg: "Downloading products.json"});
                conn.exec("cat "+taskdir+"/products.json", {}, function(err, stream) {
                    if(err) next(err);
                    var products_json = "";
                    stream.on('close', function(code, signal) {
                        if(code) return next("Failed to retrieve products.json from the task directory");
                        task.products = JSON.parse(products_json);
                        task.save(next);
                    });
                    stream.on('data', function(data) {
                        products_json += data;
                    }).stderr.on('data', function(data) {
                        logger.error(data.toString());
                    });
                });
            },
            */
        ], function(err) {
            conn.end();
            cb(err); 
        }); 
    });
    conn.on('error', cb);
    conn.on('end', function() {
        //client disconnected.. should I reconnect?
        logger.debug("ssh2 connection ended");
    });
    conn.connect({
        host: detail.hostname,
        username: resource.config.username,
        privateKey: resource.config.enc_ssh_private,
    });
}

function load_products(task, taskdir, conn, cb) {
    progress.update(task.progress_key, {msg: "Downloading products.json"});
    conn.exec("cat "+taskdir+"/products.json", {}, function(err, stream) {
        if(err) next(err);
        var products_json = "";
        stream.on('close', function(code, signal) {
            if(code) return next("Failed to retrieve products.json from the task directory");
            task.products = JSON.parse(products_json);
            task.save(cb);
        });
        stream.on('data', function(data) {
            products_json += data;
        }).stderr.on('data', function(data) {
            logger.error(data.toString());
        });
    });
}

function process_product_dep(task, dep, conn, resource, envs, cb) {
    logger.debug("handling dependency");
    logger.debug(dep);

    db.Task.findById(dep.task_id).exec(function(err, dep_task) {
        if(err) throw err;
        if(!dep_task) return cb("can't find dependency task:"+dep.task_id);
        if(dep_task.user_id != task.user_id) return cb("user_id doesn't match");

        //see if we have the dep taskdir 
        var dep_taskdir = common.gettaskdir(dep_task.workflow_id, dep_task._id, resource);
        envs["SCA_TASK_DIR_"+dep.name] = dep_taskdir;
        //if on the same resource, assume that it's there
        if(resource._id == dep_task.resources.compute) return cb();
        //always rsync for cross-resource dependency - it might not be synced yet, or out-of-sync
        db.Resource.findById(dep_task.resources.compute, function(err, source_resource) {
            if(err) return cb(err);
            if(!source_resource) return cb("couldn't find dep resource");
            if(source_resource.user_id != task.user_id) return cb("dep resource user_id doesn't match");
            common.decrypt_resource(source_resource);
            var source_taskdir = common.gettaskdir(dep_task.workflow_id, dep_task._id, source_resource);
            rsync_product(conn, source_resource, source_taskdir, dep_taskdir, cb);
        });
    });
}

function rsync_product(conn, source_resource, source_taskdir, dest_taskdir, cb) {
    async.series([
        function(next) {
            //install source key
            var key_filename = ".sca/keys/"+source_resource._id+".sshkey";
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
                var keytab = new Buffer(source_resource.config.enc_ssh_private, 'utf8');
                stream.write(keytab);
                stream.end();
            });
        },
        function(next) {
            //run rsync 
            var source_resource_detail = config.resources[source_resource.resource_id];
            var hostname = source_resource_detail.hostname;
            var sshopts = "ssh -i .sca/keys/"+source_resource._id+".sshkey";
            var source = source_resource.config.username+"@"+hostname+":"+source_taskdir+"/";
            conn.exec("rsync -av --progress -e \""+sshopts+"\" "+source+" "+dest_taskdir, function(err, stream) {
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
                var keytab = new Buffer(source_resource.config.enc_ssh_private, 'utf8');
                stream.write(keytab);
                stream.end();
            });
        },
    ], cb);
}
