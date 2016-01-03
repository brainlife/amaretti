'use strict';

//contrib
var express = require('express');
var router = express.Router();
var winston = require('winston');
var jwt = require('express-jwt');
var async = require('async');
var hpss = require('hpss');

//mine
var config = require('../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models/db');
var progress = require('../progress');

router.get('/:id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    db.Task.findById(req.params.id, function(err, task) {
        if(err) return next(err);
        if(!task) return res.status(404).end();
        if(task.user_id != req.user.sub) return res.status(401).end();
        res.json(task);
    });
});

router.post('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    //TODO it's very much specific for hpss task right now.. I need to make it more generic
    var workflow_id = req.body.workflow_id;
    var hpss_resource_id = req.body.resources.hpss;
    var compute_resource_id = req.body.resources.compute;
    var name = req.body.name;

    //make sure user owns the resources requested to run on
    db.Resource.findById(hpss_resource_id, function(err, hpss_resource) {
        if(err) return next(err);
        if(!hpss_resource) return next("couldn't find hpss resources specified");
        if(hpss_resource.user_id != req.user.sub) return res.status(401).end();
        db.Resource.findById(compute_resource_id, function(err, compute_resource) {
            if(err) return next(err);
            if(!compute_resource) return next("couldn't find compute resources specified");
            if(compute_resource.user_id != req.user.sub) return res.status(401).end();

            //make sure user owns the workflow that this task has requested under
            db.Workflow.findById(workflow_id, function(err, workflow) {
                if(workflow.user_id != req.user.sub) return res.status(401).end();
                console.dir(req.body)
                var task = new db.Task(req.body); //for workflow_id, service_id, name, resources, and config
                
                //need to set a few more things
                task.user_id = req.user.sub;
                task.progress_key = "_sca."+workflow._id+"."+task._id;//uuid.v4();
                task.status = "requested";

                //now register!
                task.save(function(err, _task) {
                    //also add reference to the workflow
                    workflow.steps[req.body.step_id].tasks.push(_task._id);
                    workflow.save(function(err) {
                        res.json({message: "Task Registered", task: _task});
                    });
                });
               
                //also send first progress update
                progress.update(task.progress_key, {name: task.name, status: 'waiting', progress: 0, msg: 'Task Requested'});
            });
        });
    });
});

module.exports = router;

