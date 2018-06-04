'use strict';

//contrib
const express = require('express');
const router = express.Router();
const winston = require('winston');
const jwt = require('express-jwt');
const async = require('async');
const mongoose = require('mongoose');
const path = require('path');
const mime = require('mime');

//mine
const config = require('../../config');
const logger = new winston.Logger(config.logger.winston);
const db = require('../models');
const common = require('../common');

/**
 * @apiGroup Task
 * @api {get} /task             Query Tasks
 * @apiDescription              Returns all tasks that belongs to a user (for admin returns all) or shared via instance.group_id
 *
 * @apiParam {Object} [find]    Optional Mongo query to perform (you need to JSON.stringify)
 * @apiParam {Object} [sort]    Mongo sort object - defaults to _id. Enter in string format like "-name%20desc"
 * @apiParam {String} [select]  Fields to load - multiple fields can be entered with %20 as delimiter
 * @apiParam {Number} [limit]   Maximum number of records to return - defaults to 100
 * @apiParam {Number} [skip]    Record offset for pagination (default to 0)
 * 
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object}         List of tasks (maybe limited / skipped) and total number of tasks
 */
router.get('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var find = {};
    if(req.query.find) find = JSON.parse(req.query.find);
    if(req.query.limit) req.query.limit = parseInt(req.query.limit);
    if(req.query.skip) req.query.skip = parseInt(req.query.skip);

    find['$or'] = [
        {user_id: req.user.sub},
        {_group_id: {$in: req.user.gids||[]}},
    ];

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
//TODO - I don't really feel this is thought through.. I might deprecate.
//current clients: 
//   * warehouse UI app stats
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

        //count distinct users requested 
        //TODO is there a better way?
        db.Taskevent.find(find).distinct('user_id').exec(function(err, users) {
            if(err) return next(err);
            res.json({
                counts: counts, 
                //tasks: tasks.length, 
                users: users.length,
            });
        });
    });
});

//return list of services currently running and number of them
router.get('/running', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    if(!req.user.scopes.amaretti || !~req.user.scopes.amaretti.indexOf("admin")) return next("admin only");
    
    //group by status and count
    db.Task.aggregate([
        {$match: {status: "running"}},
        {$group: {_id: '$service', count: {$sum: 1}}},
    ]).exec(function(err, services) {
        if(err) return next(err);
        res.json(services);
    });
 });

//get task detail
//unauthenticated user sometimes need to get task detail (like app used, etc..)
//let's allow them to query for task detail as long as they know which task id to load
router.get('/:id', /*jwt({secret: config.sca.auth_pubkey}),*/ function(req, res, next) {
    db.Task.findById(req.params.id).exec((err, task)=>{
        if(err) return next(err);
        //hide config from sensitive apps..
        if(task.service == "soichih/sca-product-raw") {
            task.config = {"masked": true};
        }
        res.json(task);
    });
});

function ls_resource(resource, _path, cb) {
    //append workdir if relateive
    if(_path[0] != "/") _path = common.getworkdir(_path, resource);

    //for ssh resource, simply readdir via sftp
    logger.debug("getting ssh connection");
    common.get_sftp_connection(resource, function(err, sftp) {
        if(err) return cb(err);
        logger.debug("reading directory:"+_path);
        var t = setTimeout(function() {
            cb("Timed out while reading directory: "+_path);
            t = null;
        }, 5000);
        sftp.readdir(_path, function(err, files) {
            if(!t) return; //timeout called already
            clearTimeout(t);
            cb(err, files);
        });
    });
}

/**
 * @apiGroup                    Task
 * @api {get} /task/ls/:taskid
 *                              List directory on task
 * @apiDescription              Get directory listing on a task.
 *
 * @apiParam {String} [p]       sub directory (relative to taskdir) to load inside the task. Use encodeURIComponent() to escape non URL characters
 *
 * @apiHeader {String}          Authorization A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccessExample {json} Success-Response:
 *  {"files":[
 *      {
 *          "filename":"config.json",
 *          "directory":false,
 *          "attrs": {
 *              "mode":33188,
 *              "mode_string":"-rw-r--r--",
 *              "uid":1170473,
 *              "owner": "hayashis",
 *              "gid":4160,
 *              "group": "hpss",
 *              "size":117,
 *              "atime":1466517617,
 *              "mtime":1466517617
 *          },
 *          "_raw":"-rw-r--r--    1 odidev   odi           117 Jun 21 10:00 config.json"
 *      }
 *  ]}
 */
router.get('/ls/:taskid', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {

    find_resource(req, req.params.taskid, (err, task, resource)=>{
        if(err) return next(err);

        get_fullpath(task, resource, req.query.p, (err, fullpath)=>{
            if(err) return next(err);

            ls_resource(resource, fullpath, function(err, files) {
                if(err) return next(err);
                var ret = [];
                //bit of standardization with ls_hpss
                files.forEach(function(file) {
                    file.attrs.mode_string = file.longname.substr(0, 10);
                    ret.push({
                        filename: file.filename,
                        directory: file.attrs.mode_string[0]=='d',
                        link: file.attrs.mode_string[0]=='l',
                        attrs: {
                            mode: file.attrs.mode,
                            mode_string: file.attrs.mode_string,
                            uid: file.attrs.uid,
                            gid: file.attrs.gid,
                            size: file.attrs.size,
                            atime: file.attrs.atime,
                            mtime: file.attrs.mtime,

                            owner: null,
                            group: null,
                        },
                        _raw: file.longname,
                    });
                });
                res.json({files: ret});
            });
        });
    });
});

//load task that user has access to and get resource where user can download the task content
function find_resource(req, taskid, cb) {
    //find specified task and make sure user has access to it
    const gids = req.user.gids||[];
    db.Task.findById(req.params.taskid, (err, task)=>{
        if(err) return cb(err);
        if(!task) return cb("no such task or you don't have access to the task");
        //logger.debug(gids, task._group_id);
        if(task.user_id != req.user.sub && !~gids.indexOf(task._group_id)) return cb("don't have access to specified task");

        //find resource that we can use to load file list
        db.Resource.findById(task.resource_id, (err, resource)=>{
            if(err) return cb(err);
            if(!resource) return cb("couldn't find the resource");
            if(resource.status == "removed") return cb("resource is removed");

            //TODO - if resource is not active(or down), then try other resources (task.resource_ids)
            if(!resource.active) return cb("resource not active");
            if(resource.status != "ok") return cb(resource.status_msg);
            if(!common.check_access(req.user, resource)) return cb("Not authorized to access this resource");
            cb(null, task, resource);
        });
    });
}

function get_fullpath(task, resource, p, cb) {
    let basepath = task.instance_id+"/"+task._id;
    let path = basepath; //base by default
    if(p) path += "/"+p; //let user specify sub directory

    //make sure path doesn't lead out of task dir
    let fullpath = common.getworkdir(path, resource);
    let safepath = common.getworkdir(basepath, resource);
    if(fullpath.indexOf(safepath) !== 0) return cb("you can't access outside of taskdir", fullpath, safepath);

    cb(null, fullpath);

}

//this API allows user to download any files under user's workflow directory
//TODO - since I can't let <a> pass jwt token via header, I have to expose it via URL.
//doing so increases the chance of user misusing the token, but unless I use HTML5 File API
//there isn't a good way to let user download files..
//getToken() below allows me to check jwt token via "at" query.
//Another way to mitigate this is to issue a temporary jwt token used to do file download (or permanent token that's tied to the URL?)
/**
 * @apiGroup Task
 * @api {get} /task/download/:taskid    
 *                              Download file/dir from task
 * @apiDescription              Download file/dir from task. If directory path is specified, it will stream tar gz-ed content
 *
 * @apiParam {String} [p]       File/directory path to download (relative to task directory. Use encodeURIComponent() to escape non URL characters
 * @apiParam {String} [at]      JWT token - if user can't provide it via authentication header
 *
 *
 * @apiHeader {String} [authorization] A valid JWT token "Bearer: xxxxx"
 *
 */
router.get('/download/:taskid', jwt({
    secret: config.sca.auth_pubkey,
    getToken: function(req) {
        //load token from req.headers as well as query.at
        if(req.query.at) return req.query.at;
        if(req.headers.authorization) {
            var auth_head = req.headers.authorization;
            if(auth_head.indexOf("Bearer") === 0) return auth_head.substr(7);
        }
        return null;
    }
}), function(req, res, next) {
    logger.debug("/task/download/"+req.params.taskid);
    
    //sometime request gets canceled, and we need to know about it to prevent ssh connections to get stuck
    let req_closed = false;
    req.on('close', ()=>{
        logger.debug("request closed");
        req_closed = true;
    });

    find_resource(req, req.params.taskid, (err, task, resource)=>{
        if(err) return next(err);

        get_fullpath(task, resource, req.query.p, (err, fullpath)=>{
            if(err) return next(err);

            logger.debug("gettingn sftp connection");
            if(req_closed) return next("request already closed.. bailing p1");
            common.get_sftp_connection(resource, function(err, sftp) {
                if(err) return next(err);

                if(req_closed) return next("request already closed.. bailing p2");

                logger.debug("sftp.stat-ing");
                sftp.stat(fullpath, function(err, stat) {
                    if(err) return next(err.toString() + " -- "+fullpath);

                    if(req_closed) return next("request already closed.. bailing p3");
                
                    if(stat.isDirectory()) {
                        logger.debug("directory.. getting ssh connection_q");
                        common.get_ssh_connection(resource, function(err, conn_q) {
                            if(err) return next(err);

                            /*
                            //TODO - I am not sure if there is more elegant way of handling this..
                            //if there are no more channels available, abort..
                            if(conn_q.counter == 0) {
                                let after = new Date();
                                after.setHours(after.getHours()+1); //ask to retry in an hour..
                                res.set("Retry-After", after.toISOString());
                                res.status(503).json({message: "connection busy. please try later"});
                                return;
                            }
                            */  

                            //compose a good unique name
                            let name = task.instance_id+"."+task._id;
                            if(req.query.p) name +="."+req.query.p.replace(/\//g, '.');
                            name += '.tar.gz';

                            res.setHeader('Content-disposition', 'attachment; filename='+name);
                            res.setHeader('Content-Type', "application/x-tgz");
                            logger.debug("running tar via conn_q");

                            if(req_closed) return next("request already closed... skipping exec()!");
                            conn_q.exec("timeout 600 bash -c \"cd \""+fullpath.addSlashes()+"\" && tar hcz *\"", (err, stream)=>{
                                if(err) return next(err);
                                if(req_closed) return stream.close("request already closed - before pipe");
                                req.on('close', ()=>{
                                    logger.debug("request close after pipe began.. closing stream");
                                    stream.close();
                                });
                                //common.set_conn_timeout(conn_q, stream, 1000*60*10); //should finish in 10 minutes right?
                                stream.pipe(res);
                            });
                        });
                    } else {
                        logger.debug("file.. streaming file via sftp", fullpath);
                        
                        //npm-mime uses filename to guess mime type, so I can use this locally
                        //TODO - but not very accurate - it looks like too many files are marked as application/octet-stream
                        let ext = path.extname(fullpath);
                        let mimetype = mime.getType(ext);
                        logger.debug("mimetype:"+mimetype);

                        //without attachment, the file will replace the current page
                        res.setHeader('Content-disposition', 'attachment; filename='+path.basename(fullpath));
                        res.setHeader('Content-Length', stat.size);
                        if(mimetype) res.setHeader('Content-Type', mimetype);
                        let stream = sftp.createReadStream(fullpath);

                        /*
                        //in case user terminate in the middle?
                        req.on('close', ()=>{
                            logger.error("request closed........ closing sftp stream");
                            stream.close();
                        });
                        */
                        stream.pipe(res);
                    }
                });
            });
        });
    });
});

/**
 * @apiGroup Task
 * @api {get} /task/upload/:taskid
 *                              Upload File
 * @apiDescription              Upload a file to specified task on a specified path
 *
 * @apiParam {String} [p]       File/directory path to download (relative to task directory. Use encodeURIComponent() to escape non URL characters
 *
 * @apiHeader {String} authorization
 *                              A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccessExample {json} Success-Response:
 *                              {file stats uploaded}
 */
router.post('/upload/:taskid', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {

    /* connectionqueue leaking has never happened here (afaik..) so let's leave this for now
    //sometime request gets canceled, and we need to know about it to prevent ssh connections to get stuck
    let req_closed = false;
    req.on('close', ()=>{
        req_closed = true;
    });
    */

    find_resource(req, req.params.taskid, (err, task, resource)=>{
        if(err) return next(err);
        
        get_fullpath(task, resource, req.query.p, (err, fullpath)=>{
            if(err) return next(err);

            common.get_ssh_connection(resource, (err, conn_q)=>{
                if(err) return next(err);

                mkdirp(conn_q, path.dirname(fullpath), err=>{
                    if(err) return next(err);

                    common.get_sftp_connection(resource, (err, sftp)=>{
                        if(err) return next(err);
                        logger.debug("fullpath",fullpath);
                        var pipe = req.pipe(sftp.createWriteStream(fullpath));
                        pipe.on('close', function() {
                            logger.debug("streaming closed");

                            //this is an undocumented feature to exlode uploade tar.gz
                            if(req.query.untar) {
                                logger.debug("tar xzf-ing");

                                //is this secure enough?
                                let cmd = "cd '"+path.dirname(fullpath).addSlashes()+"' && "+
                                    "tar xzf '"+path.basename(fullpath).addSlashes()+"' && "+
                                    "rm '"+path.basename(fullpath).addSlashes()+"'";
                                
                                conn_q.exec("timeout 600 bash -c\""+cmd+"\"", (err, stream)=>{
                                    if(err) return next(err);
                                    //common.set_conn_timeout(conn_q, stream, 1000*60*10); //should finish in 10 minutes right?
                                    stream.on('end', function() {
                                        res.json({msg: "uploaded and untared"});
                                    });
                                    stream.on('data', function(data) {
                                        logger.error(data.toString());
                                    });
                                });
                            } else {
                                //get file info (to be sure that the file is uploaded?)
                                sftp.stat(fullpath, function(err, stat) {
                                    if(err) return next(err.toString());
                                    res.json({filename: path.basename(fullpath), attrs: stat});
                                });
                            }
                        });
                        req.on('error', function(err) {
                            logger.error(err);
                            next("Failed to upload file to "+_path);
                        });
                    });
                });
            });
        });
    });
});

//TODO - should use sftp/mkdir ?
function mkdirp(conn, dir, cb) {
    logger.debug("mkdir -p "+dir);
    conn.exec("mkdir -p \""+dir.addSlashes()+"\"", {}, function(err, stream) {
        if(err) return cb(err);
        stream.on('end', function(data) {
            logger.debug("mkdirp done");
            logger.debug(data);
            cb();
        });
        stream.on('data', function(data) {
            logger.error(data.toString());
        });
    });
}

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
    const instance_id = req.body.instance_id;
    const service = req.body.service;

    //make sure user owns the workflow that this task has requested under
    db.Instance.findById(instance_id, function(err, instance) {
        if(!instance) return next("no such instance:"+instance_id);
        
        //check instance access
        //TODO is this safe if gids happens to contain undefined?
        const gids = req.user.gids||[];
        if( instance.user_id != req.user.sub && 
            !~gids.indexOf(instance.group_id)) return res.status(404).end("don't have access to specified instance");

        const task = new db.Task();

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
        if(req.body.nice && req.body.nice >= 0) task.nice = req.body.nice; //should be positive for now.

        //checked later
        if(req.body.deps) task.deps = req.body.deps.filter(dep=>dep);//remove null
        task.preferred_resource_id = req.body.preferred_resource_id;
        task.resource_deps = req.body.resource_deps;

        //others set by the API 
        task.user_id = req.user.sub;
        task._group_id = instance.group_id; //copy
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
                    db.Task.findById(taskid, function(err, dep) {
                        if(err) return next_task(err);
                        if(!dep) return next_task("can't find dep task:"+taskid);
                        if(dep.user_id != req.user.sub) return next_task("user doesn't own the dep task:"+taskid);
                        if(!~gids.indexOf(dep._group_id)) return next_task("user doesn't have access to the shared instance for dep task:", taskid);
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

                common.update_instance_status(instance_id, err=>{
                    if(err) logger.error(err);
                });
            });
           
            //also send the first progress update
            //common.progress(task.progress_key, {name: task.name||service, status: 'waiting', msg: service+' service requested'});
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
    const task_id = req.params.task_id;
    const gids = req.user.gids||[];
    db.Task.findById(task_id, function(err, task) {
        if(err) return next(err);
        if(!task) return res.status(404).end();
        if(task.user_id != req.user.sub && !~gids.indexOf(task._group_id)) return res.status(401).end("can't access this task");
        common.rerun_task(task, req.body.remove_date, err=>{
            if(err) return next(err);
            res.json({message: "Task successfully re-requested", task: task});
            common.update_instance_status(task.instance_id, err=>{
                if(err) logger.error(err);
            });
        }); 
    });
});

/**
 * @api {put} /task/poke/:taskid        Clear next_date 
 * @apiGroup Task
 * @apiDescription                      Clear next_date so that the task will be handled by task handler immediately
 *
 * @apiHeader {String} authorization    A valid JWT token "Bearer: xxxxx"
 *                              
 */
router.put('/poke/:task_id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    const task_id = req.params.task_id;
    const gids = req.user.gids||[];
    db.Task.findById(task_id, function(err, task) {
        if(err) return next(err);
        if(!task) return res.status(404).end();
        if(task.user_id != req.user.sub && !~gids.indexOf(task._group_id)) return res.status(401).end("can't access this task");
        task.next_date = undefined;
        task.save(err=>{
            if(err) return next(err);
            res.json({message: "Task poked", task: task});
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
    const task_id = req.params.task_id;
    const gids = req.user.gids||[];
    db.Task.findById(task_id, function(err, task) {
        if(err) return next(err);
        if(!task) return res.status(404).end("couldn't find such task id");
        if(task.user_id != req.user.sub && !~gids.indexOf(task._group_id)) return res.status(401).end("can't access this task");

        //TODO - _handled is deprecated, but I should still make sure that the task isn't currently handled? but how?
        //if(task._handled) return next("The task is currently handled by sca-task serivce. Please wait..");

        switch(task.status) {
        case "running":
            task.status = "stop_requested";
            task.next_date = undefined; //handle immedidately(or not?)
            task.status_msg = "Stop requested by the user";
            break;
        case "running_sync":
            //TODO - kill the process?
            break;
        case "requested":
            if(task.start_date) break; //don't stop task that's currently started
        default:
            task.status = "stopped";
            task.status_msg = "Stopped by user";
        }
        //task.products = [];
        task.save(function(err) {
            if(err) return next(err);
            /*
            common.progress(task.progress_key, {msg: 'Stop Requested'}, function() {
                res.json({message: "Task successfully requested to stop", task: task});
            });
            */
            res.json({message: "Task successfully requested to stop", task: task});
            common.update_instance_status(task.instance_id, err=>{
                if(err) logger.error(err);
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
    const task_id = req.params.task_id;
    const gids = req.user.gids||[];
    db.Task.findById(task_id, function(err, task) {
        if(err) return next(err);
        if(!task) return res.status(404).end("couldn't find such task id");
        if(task.user_id != req.user.sub && !~gids.indexOf(task._group_id)) return res.status(401).end("can't access this task");
        //if(task.status == "requested" && task.start_date) return res.status(500).end("You can not remove task that is currently started.");
        common.request_task_removal(task, function(err) {
            if(err) return next(err);
            res.json({message: "Task requested for removal"});
        }); 
    });
});

/**
 * @api {put} /task/:taskid     Update Task
 * @apiGroup Task
 * @apiDescription              This API allows you to update task detail. Normally, you don't really
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
    const id = req.params.taskid;
    const gids = req.user.gids||[];

    //warehouse service currently relies on config to store archival information
    //I need to store it somewhere else - since I shouldn't be letting user modify this

    db.Task.findById(id, function(err, task) {
        if(!task) return next("no such task:"+id);
        if(task.user_id != req.user.sub && !~gids.indexOf(task._group_id)) return res.status(401).end("can't access this task");
        
        //update fields
        for(let key in req.body) {
            //don't let some fields updated
            if(key == "_id") continue;
            if(key == "user_id") continue;
            if(key == "instance_id") continue; 
            if(key == "_group_id") continue; 
            if(key == "nice") continue;  //TODO I think I should allow user to change it as long as it positive value??

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

