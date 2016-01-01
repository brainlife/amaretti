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

router.post('/request', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    //make sure user owns the resources requested to run on
    db.Resource.findById(req.body.config.resource_ids.hpss, function(err, hpss_resource) {
        if(err) return next(err);
        if(!hpss_resource) return next("couldn't find hpss resources specified");
        if(hpss_resource.user_id != req.user.sub) return res.status(401).end();
        db.Resource.findById(req.body.config.resource_ids.compute, function(err, compute_resource) {
            if(err) return next(err);
            if(!compute_resource) return next("couldn't find compute resources specified");
            if(compute_resource.user_id != req.user.sub) return res.status(401).end();

            //make sure user owns the workflow that this task has requested under
            db.Workflow.findById(req.body.workflow_id, function(err, workflow) {
                if(workflow.user_id != req.user.sub) return res.status(401).end();
                var task = new db.Task(req.body); //for workflow_id, and request object
                //need to set a few more things
                task.user_id = req.user.sub;
                task.progress_key = "_sca."+workflow._id+"."+task._id;//uuid.v4();
                task.name = "(untitled) "+task.service_id;
                task.status = "requested";

                //now register!
                task.save(function(err, _task) {
                    res.json({message: "Task Requested", task: _task});
                });
               
                //also send first progress update
                progress.update(task.progress_key, {name: task.name, status: 'waiting', progress: 0, msg: 'Task Requested'});
            });
        });
    });
});

module.exports = router;

