'use strict';

//contrib
const express = require('express');
const router = express.Router();
const winston = require('winston');
const jwt = require('express-jwt');
const async = require('async');

//mine
const config = require('../../config');
const logger = new winston.Logger(config.logger.winston);
const db = require('../models');
const common = require('../common');

/**
 * @apiGroup Task
 * @api {get} /task             Query Tasks
 * @apiDescription              Returns all tasks that belongs to a user (for admin returns all)
 *
 * @apiParam {Object} [find]    Optional Mongo query to perform (you need to JSON.stringify)
 * @apiParam {Object} [sort]    Mongo sort object - defaults to _id. Enter in string format like "-name%20desc"
 * @apiParam {String} [select]  Fields to load - multiple fields can be entered with %20 as delimiter
 * @apiParam {Number} [limit]   Maximum number of records to return - defaults to 100
 * @apiParam {Number} [skip]    Record offset for pagination (default to 0)
 * @apiParam {String} [user_id] (Only for sca:admin) Override user_id to search (default to sub in jwt). Set it to null if you want to query all users.
 * 
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object}         List of tasks (maybe limited / skipped) and total number of tasks
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

    db.Task.find(find)
    .select(req.query.select)
    .limit(req.query.limit || 100)
    .skip(req.query.skip || 0)
    .sort(req.query.sort || '_id')
    .exec(function(err, tasks) {
        if(err) return next(err);
        db.Task.count(find).exec(function(err, count) {
            if(err) return next(err);
            res.json({tasks: tasks, count: count});
        });
        //res.json(tasks);
    });
});

//returns various event / stats for given service
router.get('/stats', /*jwt({secret: config.sca.auth_pubkey}),*/ function(req, res, next) {
    var find = {};
    if(req.query.service) find.service = req.query.service;
    if(req.query.service_branch) find.service_branch = req.query.service_branch;

    //group by status and count
    db.Taskevent.aggregate([
        {$match: find},
        {$group: {_id: '$status', count: {$sum: 1}}},
    ]).exec(function(err, statuses) {
        if(err) return next(err);
    
        var counts = {};
        statuses.forEach(status=>{
            counts[status._id] = status.count;
        });

        //count distinct tasks requested
        //TODO is there a better way?
        db.Taskevent.find(find).distinct('task_id').exec(function(err, tasks) {
            if(err) return next(err);

            //count distinct users requested 
            //TODO is there a better way?
            db.Taskevent.find(find).distinct('user_id').exec(function(err, users) {
                if(err) return next(err);
                res.json({
                    counts: counts, 
                    tasks: tasks.length, 
                    users: users.length,
                });
            });
        });
    });
});

/**
 * @api {post} /task            New Task
 * @apiGroup Task
 * @apiDescription              Submit a task under a workflow instance
 *
 * @apiParam {String} instance_id 
 *                              Instance ID to submit this task
 * @apiParam {String} service   Name of the service to run
 * @apiParam {String} [service_branch]   
 *                              Branch to use for the service (master by default)
 * @apiParam {String} [name]    Name for this task
 * @apiParam {String} [desc]    Description for this task
 * @apiParam {String} [remove_date] 
 *                              Date (in ISO format) when you want the task dir to be removed 
 *                              (won't override resource' max TTL).
 *                              (Please note that.. housekeeping will run at next_date.)
 * @apiParam {String} [max_runtime] Maximum runtime of job (in msec)
 * @apiParam {Number} [retry]   Number of time this task should be retried (0 by default)
 * @apiParam {String} [preferred_resource_id]
 *                              resource that user prefers to run this service on 
 *                              (may or may not be chosen)
 * @apiParam {Object} [config]  Configuration to pass to the service (will be stored as config.json in task dir)
 * @apiParam {String[]} [deps]  task IDs that this service depends on. This task will be executed as soon as
 *                              all dependency tasks are completed.
 * @apiParam {Object} [envs]    Dictionary of ENV parameter to set.
 * @apiParam {String[]} [resource_deps]
 *                              List of resource_ids where the access credential to be installed on ~/.sca/keys 
 *                              to allow access to the specified resource
 *
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 * @apiSuccessExample {json} Success-Response:
 *     HTTP/1.1 200 OK
 *     {
 *         "message": "Task successfully registered",
 *         "task": {...},
 *     }
 *                              
 */
router.post('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    //console.dir(req.body);
    var instance_id = req.body.instance_id;
    var service = req.body.service;

    //make sure user owns the workflow that this task has requested under
    db.Instance.findById(instance_id, function(err, instance) {
        if(!instance) return next("no such instance:"+instance_id);
        if(instance.user_id != req.user.sub) return res.status(401).end("user_id mismatch .. req.user.sub:"+req.user.sub);

        var task = new db.Task();

        //TODO validate?
        task.name = req.body.name;
        task.desc = req.body.desc;
        task.service = req.body.service;
        task.service_branch = req.body.service_branch;
        task.instance_id = req.body.instance_id;
        task.config = req.body.config;
        task.remove_date = req.body.remove_date;
        task.max_runtime = req.body.max_runtime;
        task.envs = req.body.envs;
        task.retry = req.body.retry;

        //checked later
        if(req.body.deps) task.deps = req.body.deps.filter(dep=>dep);//remove null
        task.preferred_resource_id = req.body.preferred_resource_id;
        task.resource_deps = req.body.resource_deps;

        //others set by the API 
        task.user_id = req.user.sub;
        
        //task.group_id = req.body.group_id;
        task.progress_key = common.create_progress_key(instance_id, task._id);
    
        task.status = "requested";
        task.request_date = new Date();
        task.status_msg = "Waiting to be processed by task handler";

        task.resource_ids = [];
        
        //check for various resource parameters.. make sure user has access to them
        async.series([
            function(next_check) {
                if(!task.preferred_resource_id) return next_check();
                console.log("preferreed_resource_id is set");
                db.Resource.findById(task.preferred_resource_id, function(err, resource) {
                    if(err) return next_check(err);
                    if(!resource) return next_check("can't find preferred_resource_id:"+task.preferred_resource_id);
                    if(!common.check_access(req.user, resource)) return next_check("can't access preferred_resource_id:"+task.preferred_resource_id);
                    next_check();//ok
                });
            },
            function(next_check) {
                if(!task.resource_deps) return next_check();
                //make sure user can access all resource_deps
                async.eachSeries(task.resource_deps, function(resource_id, next_resource) {
                    db.Resource.findById(resource_id, function(err, resource) {
                        if(err) return next_resource(err);
                        if(!resource) return next_check("can't find resource_id:"+resource_id);
                        if(!common.check_access(req.user, resource)) return next_resource("can't access resource_dep:"+resource_id);
                        next_resource();
                    });
                }, next_check);
            },
            function(next_check) {
                if(task.deps) return next_check();
                //make sure user owns the task
                async.eachSeries(task.deps, function(taskid, next_task) {
                    db.Task.findById(taskid, function(err, task) {
                        if(err) return next_task(err);
                        if(!task) return next_task("can't find task id:"+taskid);
                        if(task.user_id != req.user.sub) return next_task("user doesn't own the task_id"+taskid);
                        next_task();
                    });
                }, next_check);
            }
        ], function(err) {
            if(err) return next(err);
            //all good - now register!
            task.save(function(err, _task) {
                if(err) return next(err);
                //TODO - I should just return _task - to be consistent with other API
                res.json({message: "Task successfully registered", task: _task});
            });
           
            //also send the first progress update
            common.progress(task.progress_key, {name: task.name||service, status: 'waiting', msg: service+' service requested'});
        });
    });
});

/**
 * @api {put} /task/rerun/:taskid       Rerun finished / failed task
 * @apiGroup Task
 * @apiDescription                      Reset the task status to "requested" and reset products / next_date
 *
 * @apiParam {String} [remove_date]     Date (in ISO format) when you want the task dir to be removed 
 *                                      (won't override resource' max TTL)
 *
 * @apiHeader {String} authorization    A valid JWT token "Bearer: xxxxx"
 * 
 * @apiSuccessExample {json} Success-Response:
 *     HTTP/1.1 200 OK
 *     {
 *         "message": "Task successfully re-requested",
 *         "task": {},
 *     }
 *                              
 */
router.put('/rerun/:task_id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var task_id = req.params.task_id;
    db.Task.findById(task_id, function(err, task) {
        if(err) return next(err);
        if(!task) return res.status(404).end();
        if(task.user_id != req.user.sub) return res.status(401).end("user_id mismatch .. req.user.sub:"+req.user.sub);
        
        common.rerun_task(task, req.body.remove_date, err=>{
            if(err) return next(err);
            res.json({message: "Task successfully re-requested", task: task});
        }); 
    });
});

/**
 * @api {put} /task/stop/:taskid  Request task to be stopped
 * @apiGroup Task
 * @apiDescription              Set the status to "stop_requested" if running.
 *
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 * 
 * @apiSuccessExample {json} Success-Response:
 *     HTTP/1.1 200 OK
 *     {
 *         "message": "Task successfully requested to stop",
 *         "task": {},
 *     }
 *                              
 */
router.put('/stop/:task_id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var task_id = req.params.task_id;
    db.Task.findById(task_id, function(err, task) {
        if(err) return next(err);
        if(!task) return res.status(404).end("couldn't find such task id");
        if(task.user_id != req.user.sub) return res.status(401).end("user_id mismatch .. req.user.sub:"+req.user.sub);

        //TODO - _handled is deprecated, but I should still make sure that the task isn't currently handled? but how?
        //if(task._handled) return next("The task is currently handled by sca-task serivce. Please wait..");

        switch(task.status) {
        case "running":
            task.status = "stop_requested";
            task.next_date = undefined; //handle immedidately(or not?)
            task.status_msg = "";
            break;
        case "running_sync":
            //TODO - kill the process?
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

/**
 * @api {delete} /task/:taskid  Mark the task for immediate removal
 * @apiGroup Task
 * @apiDescription              Sets the remove_date to now, so that when the house keeping occurs in the next cycle,
 *                              the task_dir will be removed and status will be set to "removed". If the task is 
 *                              running, it will also set the status to "stop_requested" so that it will be 
 *                              stopped, then removed.
 *
 * @apiHeader {String} authorization 
 *                              A valid JWT token "Bearer: xxxxx"
 * 
 * @apiSuccessExample {json} Success-Response:
 *     HTTP/1.1 200 OK
 *     {
 *         "message": "Task successfully scheduled for removed",
 *     }
 *                              
 */
router.delete('/:task_id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var task_id = req.params.task_id;
    db.Task.findById(task_id, function(err, task) {
        if(err) return next(err);
        if(!task) return res.status(404).end("couldn't find such task id");
        if(task.user_id != req.user.sub) return res.status(401).end("user_id mismatch .. req.user.sub:"+req.user.sub);
        common.request_task_removal(task, function(err) {
            if(err) return next(err);
            res.json({message: "Task successfully scheduled for removed"});
        }); 
    });
});

/**
 * @api {put} /task/:taskid     Update Task
 * @apiGroup Task
 * @apiDescription              (Admin only) This API allows you to update task detail. Normally, you don't really
 *                              want to update task detail after it's submitted. Doing so might cause task to become
 *                              inconsistent with the actual state. 
 *                              To remove a field, set the field to null (not undefined - since it's not valid JSON)
 *
 * @apiParam {String} [service] Name of the service to run
 * @apiParam {String} [service_branch]   
 *                              Branch to use for the service (master by default)
 * @apiParam {String} [name]    Name for this task
 * @apiParam {String} [desc]    Description for this task
 * @apiParam {String} [remove_date] Date (in ISO format) when you want the task dir to be removed (won't override resource' max TTL)
 * @apiParam {String} [max_runtime] Maximum runtime of job (in msec)
 * @apiParam {Number} [retry]   Number of time this task should be retried (0 by default)
 * @apiParam {String} [preferred_resource_id]
 *                              resource that user prefers to run this service on 
 *                              (may or may not be chosen)
 * @apiParam {Object} [config]  Configuration for task
 * @apiParam {String[]} [deps]  task IDs that this serivce depends on. This task will be executed as soon as
 *                              all dependency tasks are completed.
 * @apiParam {String[]} [resource_deps]
 *                              List of resource_ids where the access credential to be installed on ~/.sca/keys 
 *                              to allow access to the specified resource
 *
 * @apiParam {Object} [products] Products generated by this task
 * @apiParam {String} [status]   Status of the task
 * @apiParam {String} [status_msg] Status message
 *
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 *
 */
router.put('/:taskid', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.taskid;

    //this is admin only api (for now..)
    //if(!req.user.scopes.sca || !~req.user.scopes.sca.indexOf("admin")) return res.send(401);
    //warehouse service currently relies on config to store archival information
    //I need to store it somewhere else - since I shouldn't be letting user modify this

    db.Task.findById(id, function(err, task) {
        if(!task) return next("no such task:"+id);
        if(task.user_id != req.user.sub) return res.status(401).end("user_id mismatch .. req.user.sub:"+req.user.sub);
        //update fields
        for(var key in req.body) {
            //don't let some fields updated
            if(key == "_id") continue;
            if(key == "user_id") continue;
            if(key == "instance_id") continue; 

            //TODO if status set to "requested", I need to reset handled_date so that task service will pick it up immediately.
            //and I should do other things as well..
            console.log(key)

            task[key] = req.body[key];

            //user can't set field to undefined since it's not a valid json.
            //but they can set it to null. so, to allow user to remove a field, 
            //let them set it to null, then we convert it to undefined so that
            //mongoose will remove the field when saved
            if(task[key] == null) task[key] = undefined;
        }
        task.update_date = new Date();

        task.save(function(err) {
            if(err) return next(err);
            //TODO - should I update progress?
            res.json(task);
        });
    });
});

module.exports = router;

