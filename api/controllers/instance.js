'use strict';

//contrib
var express = require('express');
var router = express.Router();
var winston = require('winston');
var jwt = require('express-jwt');
var async = require('async');
var fs = require('fs');
var ejs = require('ejs');

//mine
var config = require('../../config');
var logger = new winston.Logger(config.logger.winston);
//var common = require('../common');
var db = require('../models/db');

function getinstance(instid, req, cb) {
    db.Instance
    .findById(instid)
    .exec(function(err, instance) {
        if(err) return cb(err);
        if(!instance) return cb("404");
        if(req.user.sub != instance.user_id) return cb("401");
        cb(null, instance);
    });
}
 
//query all instances that belongs to a user
router.get('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var where = {};
    if(req.query.where) where = JSON.parse(req.query.where);
    where.user_id = req.user.sub;
    var query = db.Instance.find(where);
    if(req.query.sort) query.sort(req.query.sort);
    if(req.query.limit) query.limit(req.query.limit);
    query.exec(function(err, instances) {
        if(err) return next(err);
        res.json(instances);
    });
});

//get a single workflow instance
router.get('/:instid', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    getinstance(req.params.instid, req, function(err, instance) {
        if(err) return next(err);
        res.json(instance);
    });
});

//update workflow instance *config*
router.put('/:instid', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.instid;
    var name = req.body.name;
    var desc = req.body.desc;
    var config = req.body.config;
    db.Instance.update({_id: id, user_id: req.user.sub}, {$set: {
        name: name,
        desc: desc,
        config: config, update_date: new Date()
    }}, function(err, instance) {
        if(err) return next(err);
        res.json(instance);
    });
});

//create new instance
router.post('/:workflowid', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var instance = new db.Instance({});
    instance.workflow_id = req.params.workflowid;
    instance.name = req.body.name;
    instance.desc = req.body.desc;
    instance.config = req.body.config;

    instance.user_id = req.user.sub;
    instance.save(function(err) {
        if(err) return next(err);
        res.json(instance);
    });
});

module.exports = router;

