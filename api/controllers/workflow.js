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
    .exec(function(err, workflows) {
        if(err) return next(err);
        res.json(workflows);
    });
});

router.get('/:id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.id;
    //if(!~req.user.scopes.common.indexOf('admin')) return res.status(401).end();

    //update host info
    db.Workflow.findById(id, function(err, workflow) {
        if(err) return next(err);
        if(!workflow) return res.status(404).end();
        if(req.user.sub != workflow.user_id) return res.status(401).end();
        res.json(workflow);
    });
});

router.put('/:id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.id;
    //update workflow
    var workflow = req.body;
    workflow.update_date = new Date();
    db.Workflow.update({_id: workflow._id, user_id: req.user.sub}, {$set: workflow}, function(err, workflow) {
        if(err) return next(err);
        res.json(workflow);
    });
});

router.post('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    //logger.debug("posted");
    //console.dir(req.body);
    var workflow = new db.Workflow(req.body); //TODO - validate?
    //workflow.create_date = new Date();
    //workflow.update_date = new Date();
    workflow.user_id = req.user.sub;
    //workflow.update_date = new Date();
    workflow.save(function(err) {
        if(err) return next(err);
        res.json(workflow);
    });
});

module.exports = router;

