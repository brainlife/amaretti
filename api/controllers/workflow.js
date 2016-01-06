'use strict';

//contrib
var express = require('express');
var router = express.Router();
var winston = require('winston');
var jwt = require('express-jwt');
var async = require('async');

//mine
var config = require('../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models/db');

//get all workflows
router.get('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    db.Workflow
    .find({
        user_id: req.user.sub
    })
    .sort({'update_date':1})
    .select({
        name: 1,
        desc: 1,
        create_date: 1,
        update_date: 1
    })
    .populate('steps.tasks')
    .exec(function(err, workflows) {
        if(err) return next(err);
        res.json(workflows);
    });
});

//get a single workflow
router.get('/:id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.id;
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
});

//update workflow
router.put('/:id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.id;
    var workflow = req.body;
    db.Workflow.update({_id: id, user_id: req.user.sub}, {$set: workflow}, function(err, workflow) {
        if(err) return next(err);
        res.json(workflow);
    });
});

//create new workflow
router.post('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var workflow = new db.Workflow(req.body); //TODO - validate?
    workflow.user_id = req.user.sub;
    workflow.save(function(err) {
        if(err) return next(err);
        res.json(workflow);
    });
});

module.exports = router;

