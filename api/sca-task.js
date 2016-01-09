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
    run();
});

function run() {
    db.Task.find({status: "requested"}).exec(function(err, tasks) {
        if(err) throw err;
        logger.info("loaded "+tasks.length+" requested tasks");
        async.eachLimit(tasks, config.task_handler.concurrency, process_task, function(err) {
            logger.info("all done.. pausing for 5 seconds");
            setTimeout(run, 1000*5);
        });
    });
}

function failed(task, error, cb) {
    //mark task as failed so that it won't be picked up again
    progress.update(task.progress_key, {status: 'failed', msg: error.toString()});
    task.status = "failed";
    task.updated = new Date();
    task.save(function() {
        cb(error); //return task error.
    });
}

function process_task(task, cb) {

    //mark the task as running
    task.status = "running";
    task.save(function() {
        //load compute resource
        db.Resource.findById(task.resources.compute, function(err, resource) {
            if(err) return failed(task, err, cb);

            //run the task on the resource
            progress.update(task.progress_key, {status: 'running', progress: 0, msg: 'Processing'});
            run_task(task, resource, function(err) {
                if(err) return failed(task, err, cb);

                //all done!
                progress.update(task.progress_key, {status: 'finished', /*progress: 1,*/ msg: 'Task Completed'});
                task.status = "finished";
                task.updated = new Date();
                task.save(cb);
            });
        });
    });
}

function run_task(task, resource, cb) {
    var conn = new Client();
    conn.on('ready', function() {

        var service_id = task.service_id;
        var service_detail = config.services[service_id];
        if(!service_detail) return cb("Couldn't find such service:"+service_id);
        var workdir = common.getworkdir(task.workflow_id, resource);
        var taskdir = common.gettaskdir(task.workflow_id, task._id, resource);
        var envs = {
            SCA_WORKFLOW_ID: task.workflow_id.toString(),
            SCA_WORKFLOW_DIR: workdir,
            SCA_TASK_ID: task._id.toString(),
            SCA_TASK_DIR: taskdir,
            SCA_SERVICE_ID: service_id,
            SCA_SERVICE_DIR: "$HOME/.sca/services/"+service_id,
            SCA_PROGRESS_URL: config.progress.api+"/status",
            SCA_PROGRESS_KEY: task.progress_key,
        };

        if(service_id == null) return cb(new Error("service_id not set.."));

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
                conn.exec("cat > ~/.sca/install.sh && chmod +x ~/.sca/install.sh", function(err, stream) {
                    if(err) next(err);
                    stream.on('close', function(code, signal) {
                        if(code) return next("Failed to write ~/.sca/install.sh");
                        else next();
                    })
                    fs.createReadStream("install/install.sh").pipe(stream);
                    //stream.write();
                    //stream.end();
                });
            },
            function(next) {
                progress.update(task.progress_key+".prep", {status: 'running', progress: 0.3, msg: 'running sca install script (might take a while for the first time)'});
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
                progress.update(task.progress_key+".prep", {status: 'running', progress: 0.5, msg: 'installing/updating '+service_id+' service'});
                //logger.debug("git clone "+service_detail.giturl+" .sca/services/"+service_id);
                conn.exec("ls .sca/services/"+service_id+ " || git clone "+service_detail.giturl+" .sca/services/"+service_id, function(err, stream) {
                    if(err) next(err);
                    stream.on('close', function(code, signal) {
                        if(code) return next("Failed to git clone "+service_detail.giturl+" code:"+code);
                        else next();
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
                    });
                });
            },
            function(next) {
                progress.update(task.progress_key+".prep", {status: 'running', progress: 0.7, msg: 'Preparing taskdir'});
                logger.debug("making sure taskdir("+taskdir+") exists");
                conn.exec("mkdir -p "+taskdir, function(err, stream) {
                    if(err) next(err);
                    stream.on('close', function(code, signal) {
                        if(code) return next("Failed create taskdir:"+taskdir);
                        else next();
                    });
                });
            },

            //TODO - maybe this is handled via deps
            //process hpss resource (if exists..)
            function(next) { 
                if(!task.resources.hpss) return next();
                logger.debug("installing hpss key");
                db.Resource.findById(task.resources.hpss, function(err, resource) {
                    
                    //TODO - what if user uses nonkeytab?
                    envs.HPSS_PRINCIPAL = resource.config.username;
                    envs.HPSS_AUTH_METHOD = resource.config.auth_method;
                    envs.HPSS_KEYTAB_PATH = "$HOME/.sca/keys/"+resource._id+".keytab";

                    //create a key directory (and make sure it's 700ed)
                    conn.exec("mkdir -p .sca/keys && chmod 700 .sca/keys", function(err, stream) {
                        if(err) next(err);
                        stream.on('close', function() {
                            //now install the hpss key
                            conn.exec("cat > .sca/keys/"+resource._id+".keytab && chmod 600 .sca/keys/"+resource._id+".keytab", function(err, stream) {
                                if(err) next(err);
                                stream.on('close', function(code, signal) {
                                    if(code) return next("Failed write https keytab");
                                    else next();
                                });
                                var keytab = new Buffer(resource.config.keytab_base64, 'base64');
                                stream.write(keytab);
                                stream.end();
                            });
                        });
                    });
                });
            },

            //handle dependencies
            function(next) {
                if(!task.deps) return next(); //skip
                async.forEach(task.deps, function(dep, next_dep) {
                    //progress.update(task.progress_key+".prep.dep"+dep_idx, {status: 'running', progress: 0, msg: 'Handling dependency '+dep.id});
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
                    stream.write(JSON.stringify(task.config, null, 4));
                    stream.end();
                });
            },

            //finally, run the service!
            function(next) {
                progress.update(task.progress_key+".prep", {status: 'finished', progress: 1, msg: 'Finished preparing for task'});
                logger.debug("running service: ~/.sca/services/"+service_id+"/"+service_detail.bin.run);
                var envstr = "";
                for(var k in envs) {
                    var v = envs[k];
                    var vs = v.replace(/\"/g,'\\"')
                    envstr+=k+"=\""+vs+"\" ";
                }
                progress.update(task.progress_key, {msg: "Running Service"});
                //progress.update(task.progress_key+".service", {name: service_detail.label, status: 'running', progress: 0, msg: 'Starting Service'});
                conn.exec("cd "+taskdir+" && "+envstr+" ~/.sca/services/"+service_id+"/"+service_detail.bin.run+" > log.stdout 2>log.stderr", {
                /* BigRed2 seems to have AcceptEnv disabled in sshd_config - so I have to pass env via command line
                env: {
                    SCA_SOMETHING: 'whatever',
                }*/
                }, function(err, stream) {
                    if(err) next(err);
                    stream.on('close', function(code, signal) {
                        if(code) return next("Service failed with return code:"+code+" signal:"+signal);
                        else next();
                        //progress.update(task.progress_key, {status: 'finished', progress: 1, msg: 'Finished Successfully'}, next);
                    });
                    /*
                    .on('data', function(data) {
                        logger.info(data.toString());
                    }).stderr.on('data', function(data) {
                        logger.error(data.toString());
                    });
                    */
                });
            },
            
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
                        /*
                        //find workflow to add products to
                        db.Workflow.findById(task.workflow_id, function(err, workflow) {
                            if(err) return next(err);
                            var products = JSON.parse(products_json);
                            async.eachSeries(products, function(product, next_product) {
                                var _product = new db.Product({
                                    workflow_id: task.workflow_id,
                                    user_id: task.user_id,
                                    task_id: task._id,
                                    service_id: task.service_id,
                                    name: 'product of '+task.name,  //TODO?
                                    resources: task.resources,
                                    path: taskdir,
                                    detail: product,
                                });
                                _product.save(function(err) {
                                    if(err) return next(err);
                                    workflow.steps[task.step_id].products.push(_product._id);
                                    next_product();
                                });
                                
                            }, function(err) {
                                if(err) return next(err);
                                workflow.save(next);
                            });
                        });
                        */
                    });
                    stream.on('data', function(data) {
                        products_json += data;
                    });
                });
            },
        ], function(err) {
            conn.end();
            cb(err); 
        }); 
    });

    var detail = config.resources[resource.resource_id];
    conn.connect({
        host: detail.hostname,
        username: resource.config.username,
        privateKey: resource.config.ssh_private,
    });
}

function process_product_dep(task, dep, conn, resource, envs, cb) {
    logger.debug("handling dependency");
    logger.debug(dep);
    //dep: {task_id: 1231231323, name: "FASTA"}
    
    //TODO - algorithm
    //lookup the task, and lookup compute resource used and see if it mathes
    //if match, then all I need to do is to set ENV:FASTA to whatever gettaskdir returns.
    //if resource doesn't match, then lookup which fs/user it uses, and if they matches, I should just use gettaskdir also
    //                  if fs matches but not the user, then I need to copy data. do rsync against the user@localhost
    //if fs doesn't match , then do remote rsync

    //TODO - new (simplified) algorithm
    //check to see if the taskdir exists under current resource
    //if not, rsync from the dep resource 

    db.Task.findById(dep.task_id).exec(function(err, dep_task) {
        if(err) throw err;
        if(!dep_task) return cb("can't find dependency task:"+dep.task_id);
        if(dep_task.user_id != task.user_id) return cb("user_id doesn't match");

        //see if we have the dep taskdir 
        var dep_taskdir = common.gettaskdir(dep_task.workflow_id, dep_task._id, resource);
        conn.exec("ls "+dep_taskdir, function(err, stream) {
            if(err) cb(err);
            stream.on('close', function(code, signal) {
                switch(code) {
                case 0: 
                    logger.debug("dependency already exists on local compute resoruce:"+dep_taskdir);
                    envs["SCA_TASK_DIR_"+dep.name] = dep_taskdir;
                    cb();
                    break;
                case 1:
                    cb("TODO - need to rsync taskdir from remote resource..");
                    break;
                default:
                    cb("unknown return code while checking to see if dependency taskdir exists:"+dep_taskdir+" code:"+code);
                }
            })
        }); 
    });
}

