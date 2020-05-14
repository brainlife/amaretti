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

db.init(function(err) {
    if(err) throw err;
    logger.debug("db-initialized");
    check(); 
});

function check(cb) {
    //pick the next one to process
    db.Task.findOne({
        status: "removed", 
        resource_ids: { $gt: [] },
        $or: [
            {next_date: {$exists: false}},
            {next_date: {$lt: new Date()}}
        ]
    })
    .sort('next_date') 
    .exec((err, task) => {
        if(err) throw err; //throw and let pm2 restart
        if(!task) {
            logger.debug("nothing to do.. sleeping (10sec..)");
            return setTimeout(check, 1000*10); 
        }

        //update next_date first
        task.next_date = new Date(Date.now()+1000*3600); 
        task.save(err=>{
            if(err) logger.error(err); //continue
            logger.info("------- %s by %s id:%s %s", task.service, task.user_id, task._id.toString(), task.name);
            remove(task, err=>{
                if(err) logger.error(err); //continue
                task.save(err=>{
                    if(err) logger.error(err); //continue..
                    check();
                });
            });
        });
    });
}

function remove(task, cb) {
    //when a resource becomes inactive, some task might get stuck waiting to be removed. 
    //if the task is removed long time ago, let's assume all those resources are gone so we can move on..
    let old = new Date();
    old.setMonth(-6);
    if(task.create_date < old) {
        logger.debug("task was created very long time ago.. but still trying to remove workdir.. probably the resource used disappeard and got stuck.. clearing");
        task.resource_ids = [];
        return cb();
    }

    //start removing!
    logger.info("need to remove this task. resource_ids.length:"+task.resource_ids.length);
    async.eachSeries(task.resource_ids, function(resource_id, next_resource) {
        db.Resource.findById(resource_id, function(err, resource) {
            if(err) {
                logger.error(["failed to find resource_id:"+resource_id+" for removal.. db issue?", err]);
                return next_resource();
            }
            if(!resource || resource.status == "removed") {
                //user sometimes removes resource.. I can't never remove them, so let's mark it as gone... (bad idea?)
                logger.info("can't clean taskdir for task_id:"+task._id.toString()+" because resource_id:"+resource_id+" no longer exists in db..");
                task.resource_ids.pull(resource_id);
                return next_resource(); 
            }
            if(!resource.active) {
                logger.info("resource("+resource._id.toString()+") is inactive.. can't remove from this resource. I will wait..");
                return next_resource();
            }
            
            //TODO -should I just go ahead and try removing it?
            if(!resource.status || resource.status != "ok") {
                logger.info("can't clean taskdir on resource_id:"+resource._id.toString()+" because resource status is not ok.. can't remove from this resource");
                return next_resource();
            }

            //now the fun part!
            common.get_ssh_connection(resource, function(err, conn) {
                if(err) return next_resource(err);
                var workdir = common.getworkdir(task.instance_id, resource);
                var taskdir = common.gettaskdir(task.instance_id, task._id, resource);
                if(!taskdir || taskdir.length < 10) return next_resource("taskdir looks odd.. bailing");
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
                            task.resource_ids.pull(resource_id);
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
    }, cb);
}

