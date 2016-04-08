'use strict';

//contrib
var express = require('express');
var router = express.Router();
var winston = require('winston');
var jwt = require('express-jwt');
var async = require('async');
var fs = require('fs');
var ejs = require('ejs');
var _ = require('underscore');

//mine
var config = require('../../config');
var logger = new winston.Logger(config.logger.winston);
//var common = require('../common');
var db = require('../models/db');

function getinstance(instid, req, cb) {
    db.Workflow
    .findById(instid)
    //.populate('steps.tasks')
    //.populate('steps.products')
    .exec(function(err, instance) {
        if(err) return cb(err);
        if(!instance) return cb("404");
        if(req.user.sub != instance.user_id) return cb("401");
        cb(null, instance);
    });
}

//get a single workflow instance
router.get('/:instid', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    /*
    var id = req.params.instid;
    db.Workflow
    .findById(id)
    .populate('steps.tasks')
    .populate('steps.products')
    .exec(function(err, workflow) {
        if(err) return next(err);
        if(!workflow) return res.status(404).end();
        if(req.user.sub != workflow.user_id) return res.status(401).end();
        res.json(workflow);
    });
    */
    getinstance(req.params.instid, req, function(err, instance) {
        if(err) return next(err);
        res.json(instance);
    });
});

/*
//get a step detail in an instance
router.get('/:instid/:stepid', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var instid = req.params.instid;
    var stepid = req.params.stepid;
    console.log("looking for "+instid);
    console.log("looking for "+stepid);
    getinstance(instid, req, function(err, instance) {
        if(err) return next(err);
        var step = {};
        if(instance.steps && instance.steps[stepid]) step = instance.steps[stepid];
        res.json(step);
    });
});

//get a step detail in an instance
router.put('/:instid/:stepid', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var instid = req.params.instid;
    var stepid = req.params.stepid;
    console.log("looking for "+instid);
    console.log("looking for "+stepid);
    console.dir(req.body);
    getinstance(instid, req, function(err, instance) {
        if(err) return next(err);
        if(!instance.steps) instance.steps = {};
        instance.steps[stepid] = req.body;
        db.Workflow.update({_id: instid, user_id: req.user.sub}, {$set: instance}, function(err, workflow) {
            if(err) return next(err);
            res.json({message: "success"});
        });
        
    });
});
*/

//update workflow instance *config*
router.put('/:instid', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.instid;
    var config = req.body;
    db.Workflow.update({_id: id, user_id: req.user.sub}, {$set: {config: config, update_date: new Date()}}, function(err, workflow) {
        if(err) return next(err);
        res.json(workflow);
    });
});

//create new workflow
router.post('/:workflowid', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var instance = new db.Workflow({});
    instance.type_id = req.params.workflowid;
    instance.user_id = req.user.sub;
    instance.steps = {};
    instance.save(function(err) {
        if(err) return next(err);
        res.json(instance);
    });
});

module.exports = router;

