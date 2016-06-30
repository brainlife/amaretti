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
 
/**
 * @api {get} /instance         GetInstance
 * @apiGroup                    Instance
 * @apiDescription              Query instances that belongs to a user with given query
 *
 * @apiParam {Object} [find]    Mongo find query - defaults to {}
 * @apiParam {Object} [sort]    Mongo sort object - defaults to {}
 * @apiParam {String} [select]  Fields to load - defaults to 'logical_id'
 * @apiParam {Number} [limit]   Maximum number of records to return - defaults to 100
 * @apiParam {Number} [skip]    Record offset for pagination
 *
 * @apiHeader {String}          Authorization A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object[]}       Services Service detail
 */
router.get('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var find = {};
    if(req.query.find || req.query.where) find = JSON.parse(req.query.find || req.query.where);
    find.user_id = req.user.sub;

    db.Instance.find(find)
    .select(req.query.select)
    .limit(req.query.limit || 100)
    .skip(req.query.skip || 0)
    .sort(req.query.sort || '_id')
    .exec(function(err, instances) {
        if(err) return next(err);
        db.Instance.count(find).exec(function(err, count) {
            if(err) return next(err);
            res.json({instances: instances, count: count});
        });
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

/**
 * @api {post} /instance        PostInstance
 * @apiGroup                    Instance
 * @apiDescription              Create a new instance
 *
 * @apiParam {String} workflow_id Name of workflow that this instance belongs to (sca-wf-life)
 * @apiParam {String} name      Name of the instance
 * @apiParam {String} [desc]    Description of the instance
 * @apiParam {Object} [config]  Any information you'd like to associate with this instanace
 *
 * @apiHeader {String}          Authorization A valid JWT token "Bearer: xxxxx"
 *
 */
router.post('/:wofkflowid?', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var instance = new db.Instance({});
    instance.workflow_id = req.body.workflow_id || req.params.workflowid; //params.workflowid is dreprecated
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

