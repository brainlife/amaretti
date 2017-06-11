'use strict';

//contrib
const express = require('express');
const router = express.Router();
const winston = require('winston');
const jwt = require('express-jwt');
const async = require('async');
const fs = require('fs');
const jsonwebtoken = require('jsonwebtoken');

//mine
const config = require('../../config');
const logger = new winston.Logger(config.logger.winston);
const db = require('../models');
const common = require('../common');

/**
 * @apiGroup                    Instance
 * @api {get} /instance         Query Instance
 * @apiDescription              Query instances that belongs to a user with given query (for admin returns all)
 *
 * @apiParam {Object} [find]    Mongo find query JSON.stringify & encodeURIComponent-ed - defaults to {}
 *                              To pass regex, you need to use {$regex: "...."} format instead of js: /.../
 * @apiParam {Object} [sort]    Mongo sort object - defaults to _id. Enter in string format like "-name%20desc"
 * @apiParam {String} [select]  Fields to load - defaults to 'logical_id'. Multiple fields can be entered with %20 as delimiter
 * @apiParam {Number} [limit]   Maximum number of records to return - defaults to 100
 * @apiParam {Number} [skip]    Record offset for pagination (default to 0)
 * @apiParam {String} [user_id] (Only for sca:admin) Override user_id to search (default to sub in jwt). Set it to null if you want to query all users.
 *
 * @apiHeader {String}          Authorization A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object}         List of instances (maybe limited / skipped) and total number of instances
 */
router.get('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var find = {};
    if(req.query.find || req.query.where) find = JSON.parse(req.query.find || req.query.where);
    if(req.query.limit) req.query.limit = parseInt(req.query.limit);
    if(req.query.skip) req.query.skip = parseInt(req.query.skip);

    //handling user_id.
    if(!req.user.scopes.sca || !~req.user.scopes.sca.indexOf("admin") || find.user_id === undefined) {
        //non admin, or admin didn't set user_id
        find.user_id = req.user.sub;
    } else if(find.user_id == null) {
        //admin can set it to null and remove user_id filtering all together
        delete find.user_id;
    }


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

/**
 * @api {put} /instance/:instid Update Instance
 * @apiGroup                    Instance
 * @apiDescription              Update Instance
 *
 * @apiParam {String} [name]    Name for this instance
 * @apiParam {String} [desc]    Description for this instance
 * @apiParam {Object} [config]  Configuration for this instance
 *
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object}         Instance created
 *
 */
router.put('/:instid', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.instid;
    delete req.body.user_id; //can't change this
    delete req.body.create_date; //can't change this
    req.body.update_date = new Date();
    db.Instance.update({_id: id, user_id: req.user.sub}, {$set: req.body},
    function(err, instance) {
        if(err) return next(err);
        res.json(instance);

        //also update name on instance progress
        var progress_key = common.create_progress_key(id);
        common.progress(progress_key, {name: instance.name||instance.workflow_id||instance._id});
    });
});

/**
 * @api {post} /instance        New Instance
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
router.post('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var instance = new db.Instance({});
    instance.workflow_id = req.body.workflow_id; //|| req.params.workflowid; //params.workflowid is dreprecated
    instance.name = req.body.name;
    instance.desc = req.body.desc;
    instance.config = req.body.config;

    instance.user_id = req.user.sub;
    instance.save(function(err) {
        if(err) return next(err);
        res.json(instance);

        //set the name for the instance grouping in case use wants to display instance level progress detail
        var progress_key = common.create_progress_key(instance._id);
        common.progress(progress_key, {name: instance.name||instance.workflow_id||instance._id});
    });
});

/**
 * @api {delete} /instance/:instid
 *                              Remove the instance
 * @apiGroup                    Instance
 * @apiDescription              Sets the remove_date to now, so that when the house keeping occurs in the next cycle,
 *                              the task_dir will be removed and status will be set to "removed". If the task is
 *                              running, it will also set the status to "stop_requested" so that it will be
 *                              stopped, then removed.
 *                              Then, it will set config.removing on the instance
  *
 * @apiHeader {String} authorization
 *                              A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccessExample {json} Success-Response:
 *     HTTP/1.1 200 OK
 *     {
 *         "message": "Instance successfully scheduled for removed",
 *     }
 *
 */
router.delete('/:instid', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var instid = req.params.instid;

    //request all child tasks to be removed
    db.Task.find({instance_id: instid, user_id: req.user.sub}, function(err, tasks) {
        async.eachSeries(tasks, function(task, next_task) {
            common.request_task_removal(task, next_task);
        }, function(err) {
            if(err) return next(err);
            db.Instance.update({_id: instid, user_id: req.user.sub}, {$set: {
                'config.removing': true,
            }}, function(err, instance) {
                if(err) return next(err);
                res.json({message: "Instance successfully scheduled for removed"});
            });
        });
    });
});

module.exports = router;

