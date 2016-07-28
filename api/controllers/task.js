'use strict';

//contrib
var express = require('express');
var router = express.Router();
var winston = require('winston');
var jwt = require('express-jwt');
var async = require('async');

//mine
var config = require('../../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models/db');
var common = require('../common');

/**
 * @api {get} /task             Query Tasks
 * @apiParam {Object} find      Optional Mongo query to perform
 * @apiDescription              Returns all tasks that belongs to a user
 * @apiGroup Task
 * 
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object[]} tasks Task detail
 */
router.get('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var find = {};
    if(req.query.find || req.query.where) find = JSON.parse(req.query.find || req.query.where);
    find.user_id = req.user.sub;
    var query = db.Task.find(find);
    if(req.query.sort) query.sort(req.query.sort);
    if(req.query.limit) query.limit(req.query.limit);
    query.exec(function(err, tasks) {
        if(err) return next(err);
        res.json(tasks);
    });
});

/*
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
*/

/**
 * @api {post} /task            New Task
 * @apiGroup Task
 * @apiDescription              Submit a task under a workflow instance
 *
 * @apiParam {String} instance_id 
 *                              Instance ID to submit this task
 * @apiParam {String} [group_id]
 *                              Group ID to group the task inside the instance for progress report
 * @apiParam {String} service   
 *                              Name of the service to run
 * @apiParam {String} [name]    Name for this task
 * @apiParam {String} [desc]    Description for this task
 * @apiParam {String} [preferred_resource_id]
 *                              resource that user prefers to run this service on 
 *                              (may or may not be chosen)
 * @apiParam {Object} [config]  Configuration to pass to the service (will be stored as config.json in task dir)
 * @apiParam {String[]} [deps]  task IDs that this serivce depends on. This task will be executed as soon as
 *                              all dependency tasks are completed.
 * @apiParam {String[]} [resource_deps]
 *                              List of resource_ids where the access credential to be installed on ~/.sca/keys 
 *                              to allow access to the specified resource
 *
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 * @apiSuccessExample {json} Success-Response:
 *     HTTP/1.1 200 OK
 *     {
 *         "message": "Task successfully registered",
 *         "task": {},
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
        task.instance_id = req.body.instance_id;
        task.config = req.body.config;

        //checked later
        task.deps = req.body.deps;
        task.preferred_resource_id = req.body.preferred_resource_id;
        task.resource_deps = req.body.resource_deps;

        //others set by the API 
        task.user_id = req.user.sub;

        task.group_id = req.body.group_id;
        
        //construct progress key
        task.progress_key = "_sca."+instance_id;
        if(task.group_id) task.progress_key += "."+task.group_id;
        task.progress_key +="."+task._id;
    
        task.status = "requested";
        task.request_date = new Date();
        task.status_msg = "Waiting to be processed by SCA task handler";

        //console.dir(task);
        
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
                res.json({message: "Task successfully registered", task: _task});
            });
           
            //also send the first progress update
            common.progress(task.progress_key, {name: task.name||service, status: 'waiting', msg: service+' service requested'});
        });
    });
});

/**
 * @api {put} /task/rerun/:taskid     Rerun finished / failed task
 * @apiGroup Task
 * @apiDescription              Reset the task status to "requested" and reset products / next_date
 *
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
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
        
        task.status = "requested";
        task.status_msg = "";
        task.request_date = new Date();
        task.start_date = undefined;
        task.finish_date = undefined;
        task.next_date = undefined;
        task.products = undefined;
        task.save(function(err) {
            if(err) return next(err);
            common.progress(task.progress_key, {status: 'waiting', /*progress: 0,*/ msg: 'Task Re-requested'}, function() {
                res.json({message: "Task successfully re-requested", task: task});
            });
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
 * @api {delete} /task/:taskid  Remove a task
 * @apiGroup Task
 * @apiDescription              Physically remove a task from DB. Tasks that depends on deleted task will not be removed
 *                              but will point to now missing task. Which may or may not fail.
 *
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 * 
 * @apiSuccessExample {json} Success-Response:
 *     HTTP/1.1 200 OK
 *     {
 *         "message": "Task successfully removed",
 *     }
 *                              
 */
router.delete('/:task_id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var task_id = req.params.task_id;
    db.Task.remove({_id: task_id, user_id: req.user.sub}, function(err) {
        if(err) return next(err);
        res.json({message: "Task successfully removed"});
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
 * @apiParam {String} [name]    Name for this task
 * @apiParam {String} [desc]    Description for this task
 * @apiParam {String} [service]
 *                              Name of the service to run
 * @apiParam {String} [preferred_resource_id]
 *                              resource that user prefers to run this service on 
 *                              (may or may not be chosen)
 * @apiParam {Object} [config]  Configuration to pass to the service (will be stored as config.json in task dir)
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
    if(!req.user.scopes.sca || !~req.user.scopes.sca.indexOf("admin")) return res.send(401);

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

    /*
    {
        name: req.body.name,
        desc: req.body.desc,
        instance_id: req.body.instance_id,
        service: req.body.service,
        preferred_resource_id: req.body.preferred_resource_id,
        config: req.body.config,
        deps: req.body.deps,
        resource_deps: req.body.resource_deps,
        products: req.body.products,
        status: req.body.status,
        status_msg: req.body.status_msg,
    }*/
});

module.exports = router;

