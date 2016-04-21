'use strict';

//contrib
var express = require('express');
var router = express.Router();
var winston = require('winston');
var jwt = require('express-jwt');
var async = require('async');
var hpss = require('hpss');

//mine
var config = require('../../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models/db');
var common = require('../common');
//var progress = require('../progress');

/*
//TODO deprecated by get:/?
router.get('/recent', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    db.Task.find({
        user_id: req.user.sub,
        create_date: { "$gte": new Date(2016,0,1)},  //TODO - make this not hardcoded..
    }, function(err, tasks) {
        if(err) return next(err);
        res.json(tasks);
    });
});
*/

//TODO deprecated by get:/?
router.get('/:id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    db.Task
    .findById(req.params.id)
    //.populate('deps')
    //.populate('resource_id') //I think resource_id expand to resource is confusing.. I will populate it to _resource below
    .lean()
    .exec(function(err, task) {
        if(err) return next(err);
        if(!task) return res.status(404).end();
        if(task.user_id != req.user.sub) return res.status(401).end();

        //populate resource info
        if(task.resource_id) {
            db.Resource.findById(task.resource_id)
            .select('type name status status_msg')
            .exec(function(err, resource) {
                if(err) return next(err); 
                task._resource = resource;
                res.json(task);
            });
        } else res.json(task);
    });
});

//get all tasks that belongs to a user (with query.)
router.get('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var where = {};
    if(req.query.where) where = JSON.parse(req.query.where);
    where.user_id = req.user.sub;
    //logger.debug("searching task with following where");
    //console.dir(where);
    var query = db.Task.find(where);
    if(req.query.sort) query.sort(req.query.sort);
    if(req.query.limit) query.limit(req.query.limit);
    query.exec(function(err, tasks) {
        if(err) return next(err);
        res.json(tasks);
    });
});

//make sure all resources exists, and are owned by the user.sub
function check_resource_access(user, ids, cb) {
    async.forEachOf(ids, function(id, key, next) {
        var id = ids[key];
        db.Resource.findById(id, function(err, resource) {
            if(err) return next(err);
            if(!resource) return next("couldn't find hpss resources specified");
            if(resource.user_id != user.sub) return next("404");
            next(null);
        });
    }, cb);
}

//submit a task under a workflow instance
router.post('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var instance_id = req.body.instance_id;
    var service_id = req.body.service_id;

    //make sure user owns the workflow that this task has requested under
    db.Instance.findById(instance_id, function(err, instance) {
        if(instance.user_id != req.user.sub) return res.status(401).end();
        var task = new db.Task({}); 
        task.instance_id = instance_id;
        task.service_id = service_id;
        task.user_id = req.user.sub;
        task.progress_key = "_sca."+instance_id+"."+task._id;
        task.status = "requested";
        task.status_msg = "";
        task.name = req.body.name;
        task.desc = req.body.desc;
        task.config = req.body.config;
        task.deps = req.body.deps;

        //setting this to resource_id doesn't gurantee that it will run there.. this is to help sca-task decide where to run the task
        task.resource_id = req.body.resource_id;

        //now register!
        task.save(function(err, _task) {
            /*
            //also add reference to the workflow
            if(!instance.steps[step_id]) instance.steps[step_id] = {tasks: []};
            instance.steps[step_id].tasks.push(_task._id);
            workflow.save(function(err) {
                if(err) return next(err);
                res.json({message: "Task successfully requested", task: _task});
            });
            */
            res.json({message: "Task successfully registered", task: _task});
        });
       
        //also send first progress update
        common.progress(task.progress_key, {name: task.name, status: 'waiting', progress: 0, msg: service_id+' service requested'});
    });
    //});
});

router.put('/rerun/:task_id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var task_id = req.params.task_id;
    db.Task.findById(task_id, function(err, task) {
        if(err) return next(err);
        if(!task) return res.status(404).end();
        if(task.user_id != req.user.sub) return res.status(401).end();
        
        task.status = "requested";
        task.status_msg = "";
        //task.products = []; 
        task.save(function(err) {
            if(err) return next(err);
            common.progress(task.progress_key, {status: 'waiting', progress: 0, msg: 'Task Re-requested'}, function() {
                res.json({message: "Task successfully re-requested", task: task});
            });
        });
    });
});

router.put('/stop/:task_id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var task_id = req.params.task_id;
    db.Task.findById(task_id, function(err, task) {
        if(err) return next(err);
        if(!task) return res.status(404).end();
        if(task.user_id != req.user.sub) return res.status(401).end();
        if(task._handled) return next("The task is currently handled by sca-task serivce. Please wait..");

        switch(task.status) {
        case "running":
            task.status = "stop_requested";
            task.status_msg = "";
            break;
        default:
            task.status = "stopped";
            task.status_msg = "";
        }
        //task.products = [];
        task.save(function(err) {
            if(err) return next(err);
            common.progress(task.progress_key, {msg: 'Stop Requested'}, function() {
                res.json({message: "Task successfully requested to stop", task: task});
            });
        });
    });
});

module.exports = router;

