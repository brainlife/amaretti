'use strict';

const express = require('express');
const router = express.Router();
const async = require('async');
const mongoose = require('mongoose');
const path = require('path');
const mime = require('mime');
const multer = require('multer');
const fs = require('fs');

const config = require('../../config');
const db = require('../models');
const events = require('../events');
const common = require('../common');

const upload = multer({dest: "/tmp"}); //TODO - might run out of disk?

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
router.get('/', common.jwt(), function(req, res, next) {
    var find = {};
    if(req.query.find) find = JSON.parse(req.query.find);
    if(req.query.limit) req.query.limit = parseInt(req.query.limit);
    if(req.query.skip) req.query.skip = parseInt(req.query.skip);

    if(!req.user.scopes.amaretti || !~req.user.scopes.amaretti.indexOf("admin")) {
        //only return task that user has submitted or belongs to the _group_id(project for warehouse) that user is member of
        find['$or'] = [
            {user_id: req.user.sub},
            {_group_id: {$in: req.user.gids||[]}},
        ];
    }

    //if(req.query.select) console.log("select:"+req.query.select);

    db.Task.find(find)
    .lean()
    .select(req.query.select)
    .limit(req.query.limit || 100)
    .skip(req.query.skip || 0)
    .sort(req.query.sort)
    .exec(function(err, tasks) {
        if(err) return next(err);
        res.json({tasks});
    });
});

//(admin only) aggregate task by service/resource_id
//users:
//  warehouse / common.update_project_stats (used by warehouse/bin/projectinfo)
router.get('/resource_usage', common.jwt(), function(req, res, next) {
    if(!req.user.scopes.amaretti || !~req.user.scopes.amaretti.indexOf("admin")) return next("admin only");

    var find = {};
    if(req.query.find) find = JSON.parse(req.query.find);
    
    //group by status and count
    db.Task.aggregate([
        {$match: find},

        {   
            //TODO - working to switch to use walltime field
            $project: {
                _walltime: {$subtract: ["$finish_date", "$start_date"]},
                service: 1,
                resource_id: 1,
            }
        },

        {
            $group: {
                _id: {service: "$service", resource_id: "$resource_id"}, 
                count: {$sum: 1}, 
                total_walltime: {$sum: "$_walltime"}
            }
        },

    ]).exec(function(err, counts) {
        if(err) return next(err);
        res.json(counts);
    });
});

//(admin only) return list of services currently running and number of them
//who uses this? (can I deprecate this?)
router.get('/running', common.jwt(), function(req, res, next) {
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

//return a list of tasks submitted for a service
//client ui > warehouse/app.vue
router.get('/recent', common.jwt(), async (req, res, next)=>{

    let service = req.query.service;
    //TODO should I hide hidden service?

    const select = '_id user_id _group_id service service_branch '+
                   'status status_msg create_date request_date '+
                   'start_date finish_date fail_date resource_id ';

    let current = await db.Task.find({
        service,
        status: {$in: ["requested", "running", "running_sync"]},
    }).lean()
    .select(select)
    .sort({create_date: -1})
    .limit(30)
    .exec()
    
    let recent = await db.Task.find({
        service,
        status: {$in: ["finished", "failed", /*"removed"*/]},
    }).lean()
    .select(select)
    .sort({create_date: -1})
    .limit(20)
    .exec()

    res.json({recent: [...current, ...recent]});
});


//query for task products in batch
/**
 * @apiGroup Task
 * @api {get} /task             Return task products
 * @apiDescription              Query for tasks and return products for each tasks
 * @apiParam String[] ids       List of IDS in array (don't stringify)
 * 
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object[]}         List of product objects
 */
router.get('/product', common.jwt(), async (req, res, next)=>{
    let ids = req.query.ids;
    let find = {_id: {$in: ids}};
    //access control
    if(!req.user.scopes.amaretti || !~req.user.scopes.amaretti.indexOf("admin")) {
        find['$or'] = [
            {user_id: req.user.sub},
            {_group_id: {$in: req.user.gids||[]}},
        ];
    }
    let tasks = await db.Task.find(find).select('_id').exec();
    db.Taskproduct.find({task_id: {$in: tasks}}).lean().exec((err, recs)=>{
        if(err) return next(err);
        res.json(recs);
    });
});

//get task detail
//unauthenticated user sometimes need to get task detail (like app used, etc..)
//let's allow them to query for task detail as long as they know which task id to load
router.get('/:id', (req, res, next)=>{
    db.Task.findById(req.params.id).exec((err, task)=>{
        if(err) return next(err);
        if(!task) return next("no such task id");
        res.json(task);
    });
});

function ls_resource(resource, _path, cb) {
    //append workdir if relateive
    if(_path[0] != "/") _path = common.getworkdir(_path, resource);

    //for ssh resource, simply readdir via sftp
    console.info("getting ssh connection");
    common.get_sftp_connection(resource, function(err, sftp) {
        if(err) return cb(err);
        //console.info("reading directory:"+_path);
        var t = setTimeout(function() {
            cb("Timed out while reading directory: "+_path);
            t = null;
        }, 5000); //sometimes it times out with 5 sec.. but I am not sure if increasing timeout is the right solution
        sftp.readdir(_path, function(err, files) {
            if(!t) return; //timeout called already
            clearTimeout(t);
            if(err) return cb(err);

            //I need to stat each symlink files to find out if it's directory or not
            async.eachSeries(files, (file, next_file)=>{
                file.attrs.mode_string = file.longname.substr(0, 10);
                if(file.attrs.mode_string[0]=='l') {
                    file.link = true;
                    sftp.stat(_path+"/"+file.filename, (err, stat)=>{
                        if(err) {
                            console.error("broken symlink: %s", file.filename);
                            return next_file();
                        }
                        file.directory = stat.isDirectory();
                        next_file();
                    });
                } else {
                    file.directory = file.attrs.mode_string[0]=='d';
                    file.link = false;
                    next_file();
                }
            }, err=>{
                if(err) return cb(err);
                
                //bit of standardization with ls_hpss
                var ret = [];
                files.forEach(function(file) {
                    ret.push({
                        filename: file.filename,
                        directory: file.directory,
                        link: file.link,
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

                cb(null, ret);
            });
            
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
router.get('/ls/:taskid', common.jwt(), function(req, res, next) {

    find_resource(req, req.params.taskid, (err, task, resource)=>{
        if(err) return next(err);

        get_fullpath(task, resource, req.query.p, (err, fullpath)=>{
            if(err) return next(err);

            ls_resource(resource, fullpath, (err, files)=>{
                if(err) return next(err);
                events.publish("task.ls."+(task._group_id||'ng')+"."+task.user_id+"."+task.instance_id+"."+task._id, {
                    fullpath,
                    resource_id: resource._id,
                    resource_name: resource.name,
                });
                res.json({files});
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
        if(!task) return cb("no such task");
        //make sure user owns this or member of the group
        if(!req.user.scopes.amaretti || !~req.user.scopes.amaretti.indexOf("admin")) {
            if(task.user_id != req.user.sub && !~gids.indexOf(task._group_id)) return cb("don't have access to specified task");
        }

        //I can't put resource_id as it might not be in resource_ids (resource_id is where it ran last time?)
        //let resource_ids = [/*task.resource_id,*/ ...task.resource_ids.reverse()]; 
        async.eachSeries(task.resource_ids, (resource_id, next_resource)=>{
            db.Resource.findById(resource_id, (err, resource)=>{
                if(err) return next_resource(err);
                if(!resource) return next_resource("couldn't find the resource:"+resource_id); //broken?
                if(!resource.active) return next_resource();
                if(resource.status != "ok") return next_resource();
                cb(null, task, resource);
            });
        }, err=>{
            cb(err||"no resource currently available to download this task:"+req.params.taskid);
        })
    });
}

function get_fullpath(task, resource, p, cb) {
    let basepath = task.instance_id+"/"+task._id;
    let path = basepath; //base by default
    if(p) path += "/"+p; //let user specify sub directory

    //make sure path doesn't lead out of task dir
    //WARNING - this doesn't prevent symlinked files to point outside of the task dir.. and expose those files
    //this is to make sure our *API user* from escaping out of the task dir. App developer can symlink, copy , etc.. 
    //any files that they have access to and make it part of the workdir which we can't really do anything about.
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
 * @api {get} /task/download/:taskid/*
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

router.get('/download/:taskid/*', common.jwt({
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

    let p = req.query.p || req.params[0];
    console.info("/task/download/"+req.params.taskid+" "+p);
    
    //sometime request gets canceled, and we need to know about it to prevent ssh connections to get stuck
    //only thrown if client terminates request (including no change?)
    let req_closed = false;
    req.on('close', ()=>{
        console.info("req/close");
        req_closed = true;
    });

    find_resource(req, req.params.taskid, (err, task, resource)=>{
        if(err) return next(err);

        get_fullpath(task, resource, p, (err, fullpath)=>{
            if(err) return next(err);

            events.publish("task.download."+(task._group_id||'ng')+"."+task.user_id+"."+task.instance_id+"."+task._id, {
                fullpath,
                resource_id: resource._id,
                resource_name: resource.name,
            });

            console.info("gettingn sftp connection");
            if(req_closed) return next("request already closed.. bailing p1");
            common.get_sftp_connection(resource, function(err, sftp) {
                if(err) return next(err);

                if(req_closed) return next("request already closed.. bailing p2");
                sftp.stat(fullpath, function(err, stat) {
                    if(err) return next(err.toString() + " -- "+fullpath);

                    if(req_closed) return next("request already closed.. bailing p3");
                    if(stat.isDirectory()) {
                        console.info("directory.. getting ssh connection_q");
                        common.get_ssh_connection(resource, function(err, conn_q) {
                            if(err) return next(err);

                            //compose a good unique name
                            let name = task.instance_id+"."+task._id;
                            if(p) name +="."+p.replace(/\//g, '.');
                            name += '.tar.gz';

                            res.setHeader('Content-disposition', 'attachment; filename='+name);
                            res.setHeader('Content-Type', "application/x-tgz");
                            console.info("running tar via conn_q");

                            if(req_closed) return next("request already closed... skipping exec()!");
                            conn_q.exec("timeout 600 bash -c \"cd \""+fullpath.addSlashes()+"\" && tar --exclude='.*' -hcz *\"", (err, stream)=>{
                                if(err) return next(err);
                                if(req_closed) return stream.close();
                                req.on('close', ()=>{
                                    console.info("request close after pipe began.. closing stream");
                                    stream.close();
                                });
                                //common.set_conn_timeout(conn_q, stream, 1000*60*10); //should finish in 10 minutes right?
                                stream.pipe(res);
                            });
                        });
                    } else {
                        console.info("file.. streaming file via sftp", fullpath);
                        
                        //npm-mime uses filename to guess mime type, so I can use this locally
                        //TODO - but not very accurate - it looks like too many files are marked as application/octet-stream
                        let ext = path.extname(fullpath);
                        let mimetype = mime.getType(ext);
                        console.info("mimetype:"+mimetype);

                        //without attachment, the file will replace the current page
                        res.setHeader('Content-disposition', 'attachment; filename='+path.basename(fullpath));
                        res.setHeader('Content-Length', stat.size);
                        res.setHeader('Content-Type', mimetype||"application/octet-stream"); //not setting content-type causes firefox to raise XML error
                        sftp.createReadStream(fullpath, (err, stream)=>{
                            //in case user terminates in the middle.. read stream doesn't raise any event!
                            if(req_closed) return stream.close();
                            req.on('close', ()=>{
                                console.info("request closed........ closing sftp stream also");
                                stream.close();
                            });
                            stream.pipe(res);
                        });
                    }
                });
            });
        });
    });
});

/**
 * @apiGroup Task
 * @api {get} /task/upload/:taskid
 *                              Upload File (DEPRECATED - use upload2 with FormData/multipart)
 * @apiDescription              Upload a file to specified task on a specified path (task will be locked afterward)
 *
 * @apiParam {String} [p]       File/directory path to upload to (relative to task directory. Use encodeURIComponent() to escape non URL characters
 *
 * @apiHeader {String} authorization
 *                              A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccessExample {json} Success-Response:
 *                              {file stats uploaded}
 */

router.post('/upload/:taskid', common.jwt(), function(req, res, next) {

    find_resource(req, req.params.taskid, (err, task, resource)=>{
        if(err) return next(err);

        if(task.status != "finished") return next("you can only upload to finished service");
        if(!common.check_access(req.user, resource)) return next("Not authorized to access this resource");
        
        get_fullpath(task, resource, req.query.p, (err, fullpath)=>{
            if(err) return next(err);

            events.publish("task.upload."+(task._group_id||'ng')+"."+task.user_id+"."+task.instance_id+"."+task._id, {
                fullpath,
                resource_id: resource._id,
                resource_name: resource.name,
            });

            //lock the task so user can not execute it again (to prevent malicious use of this task)
            task.locked = true;
            task.save(err=>{
                if(err) return next(err);
                common.get_ssh_connection(resource, (err, conn_q)=>{
                    if(err) return next(err);

                    mkdirp(conn_q, path.dirname(fullpath), err=>{
                        if(err) return next(err);

                        common.get_sftp_connection(resource, (err, sftp)=>{
                            if(err) return next(err);
                            console.info("fullpath",fullpath);
                            sftp.createWriteStream(fullpath, (err, write_stream)=>{

                                /*
                                //just in case..
                                req.on('close', ()=>{
                                    console.error("request closed........ closing sftp stream also");
                                    write_stream.close();
                                });
                                */

                                var pipe = req.pipe(write_stream);
                                pipe.on('close', function() {
                                    console.info("streaming closed");

                                    //this is an undocumented feature to exlode uploade tar.gz
                                    if(req.query.untar) {

                                        //is this secure enough?
                                        let cmd = "cd '"+path.dirname(fullpath).addSlashes()+"' && "+
                                            "tar xzf '"+path.basename(fullpath).addSlashes()+"' && "+
                                            "rm '"+path.basename(fullpath).addSlashes()+"'";

                                        //console.debug(cmd);
                                        
                                        conn_q.exec("timeout 600 bash -c \""+cmd+"\"", (err, stream)=>{
                                            if(err) return next(err);
                                            //common.set_conn_timeout(conn_q, stream, 1000*60*10); //should finish in 10 minutes right?
                                            stream.on('end', function() {
                                                res.json({msg: "uploaded and untared"});
                                            });
                                            stream.on('data', function(data) {
                                                console.error(data.toString());
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
                                    console.error(err);
                                    next("Failed to upload file to "+_path);
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

/** 
 * @apiGroup Task
 * @api {get} /task/upload/:taskid
 *                              Upload File (using multipart)
 * @apiDescription              Upload a file to specified task on a specified path (task will be locked afterward)
 *
 * @apiParam {String} [p]       File/directory path to download (relative to task directory. Use encodeURIComponent() to escape non URL characters. if you don't set this, the file will be stored in the task directory using originalname
 * @apiParam {String} [untar]   Untar .tar input after it's uploaded
 *
 * @apiHeader {String} authorization
 *                              A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccessExample {json} Success-Response:
 *                              {file stats uploaded}
 */

router.post('/upload2/:taskid', common.jwt(), upload.single('file'), function(req, res, next) {

    find_resource(req, req.params.taskid, (err, task, resource)=>{
        if(err) return next(err);

        if(task.status != "finished") return next("you can only upload to finished service");
        if(!common.check_access(req.user, resource)) return next("Not authorized to access this resource");
    
        //req.file
        /*
        {
          fieldname: 'file',
          originalname: 'sub-OpenSciJan22_phasediff.nii.gz',
          encoding: '7bit',
          mimetype: 'application/gzip',
          destination: '/tmp',
          filename: '8af1174d9e1188fe9084de5d90b0ea75',
          path: '/tmp/8af1174d9e1188fe9084de5d90b0ea75',
          size: 223679
        }
        */
        let p = req.query.p||req.file.originalname;
        get_fullpath(task, resource, p, (err, fullpath)=>{
            if(err) return next(err);
            console.log("using fullpath", fullpath);

            events.publish("task.upload."+(task._group_id||'ng')+"."+task.user_id+"."+task.instance_id+"."+task._id, {
                fullpath,
                resource_id: resource._id,
                resource_name: resource.name,
            });

            //lock the task so user can not execute it again (to prevent malicious use of this task)
            task.locked = true;
            task.save(err=>{
                if(err) return next(err);
                common.get_ssh_connection(resource, (err, conn_q)=>{
                    if(err) return next(err);

                    mkdirp(conn_q, path.dirname(fullpath), err=>{
                        if(err) return next(err);

                        common.get_sftp_connection(resource, (err, sftp)=>{
                            if(err) return next(err);
                            console.info("fullpath",fullpath);

                            const readStream = fs.createReadStream(req.file.path);
                            sftp.createWriteStream(fullpath, (err, write_stream)=>{

                                /*
                                //just in case..
                                readstream.on('close', ()=>{
                                    console.error("request closed........ closing sftp stream also");
                                    write_stream.close();
                                });
                                */

                                var pipe = readStream.pipe(write_stream);
                                pipe.on('close', function() {
                                    console.info("streaming closed.. removing uploaded file");
                                    fs.unlinkSync(req.file.path);

                                    //this is an undocumented feature to exlode uploade tar.gz
                                    if(req.query.untar) {
                                        console.info("tar xzf-ing");

                                        //is this secure enough?
                                        let cmd = "cd '"+path.dirname(fullpath).addSlashes()+"' && "+
                                            "tar xzf '"+path.basename(fullpath).addSlashes()+"' && "+
                                            "rm '"+path.basename(fullpath).addSlashes()+"'";
                                        
                                        conn_q.exec("timeout 600 bash -c \""+cmd+"\"", (err, stream)=>{
                                            if(err) return next(err);
                                            //common.set_conn_timeout(conn_q, stream, 1000*60*10); //should finish in 10 minutes right?
                                            stream.on('end', function() {
                                                res.json({msg: "uploaded and untared"});
                                            });
                                            stream.on('data', function(data) {
                                                console.error(data.toString());
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
                                readStream.on('error', function(err) {
                                    console.error(err);
                                    next("Failed to upload file to "+_path);
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});


//TODO - should use sftp/mkdir ?
function mkdirp(conn, dir, cb) {
    console.info("mkdir -p "+dir);
    conn.exec("mkdir -p \""+dir.addSlashes()+"\"", {}, function(err, stream) {
        if(err) return cb(err);
        stream.on('end', data=>{
            console.info("mkdirp done");
            cb();
        });
        stream.on('data', data=>{
            console.error(data.toString());
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
 * @apiParam {String} [follow_task_id]
 *                              Task ID to follow (admin only)
 * @apiParam {String} [preferred_resource_id]
 *                              resource that user prefers to run this service on 
 *                              (may or may not be chosen)
 * @apiParam {Object} [config]  Configuration to pass to the service (will be stored as config.json in task dir)
 * @apiParam {String[]} [deps]  (deprecated by deps_config) task IDs that this service depends on. This task will be executed as soon as
 *                              all dependency tasks are completed.
 * @apiParam {Object[]} [deps_config]  
 *                              task IDs that this service depends on. This task will be executed as soon as
 *                              all dependency tasks are completed.
 * @apiParam {String[]} [resource_deps] (deprecated?)
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
router.post('/', common.jwt(), function(req, res, next) {
    if(!req.body.instance_id) return next("please specify instance_id");
    if(!req.body.service) return next("please specify service");

    const instance_id = req.body.instance_id;
    const service = req.body.service;

    //make sure user owns the workflow that this task has requested under
    db.Instance.findById(instance_id, function(err, instance) {
        if(!instance) return next("no such instance:"+instance_id);
        
        const task = new db.Task();

        //TODO validate?
        task.name = req.body.name;
        task.desc = req.body.desc;
        task.service = req.body.service;
        task.service_branch = req.body.service_branch;
        task.instance_id = instance_id;
        task.config = req.body.config;
        task.remove_date = req.body.remove_date;
        task.max_runtime = req.body.max_runtime;
        task.retry = req.body.retry;
        if(req.body.nice && req.body.nice >= 0) task.nice = req.body.nice; //should be positive for now.

        if(task.name) task.name = task.name.trim();

        //deps is deprecated, but might be used by old cli / existing tasks
        if(req.body.deps) {
            console.warn("req.body.deps set.. which is deprecated by deps_config");
            let deps = req.body.deps.filter(dep=>dep);//remove null

            //migrate to deps_config
            req.body.deps_config = [];
            deps.forEach(dep=>{
                deps.push({task: dep});
            });
        }

        if(req.body.deps_config) {
            //dedupe while copying deps_config to task.deps_conf
            //the same task id / subdir combinations from deps_config
            //TODO - validate?
            console.debug("req.body.deps_config", req.body.deps_config)
            task.deps_config = [];
            req.body.deps_config.forEach(conf=>{
                let existing = task.deps_config.find(c=>c.task == conf.task);
                if(existing) {
                    //merge config
                    if(conf.subdirs) {
                        if(existing.subdirs) {
                            let merged = [...existing.subdirs, ...conf.subdirs];
                            existing.subdirs = [...new Set(merged)];//dedupe subdirs
                        }
                    } else {
                        //reset subdir as we now need the whole task
                        existing.subdirs = undefined;
                    }
                } else {
                    task.deps_config.push(conf);
                }
            });
            //console.debug("task.deps_config", task.deps_config)
        }

        //TODO - validate?
        task.preferred_resource_id = req.body.preferred_resource_id;
        task.resource_deps = req.body.resource_deps;

        //others set by the API 
        task._group_id = instance.group_id; //copy
        task.status = "requested";
        task.request_date = new Date();
        task.status_msg = "Waiting to be processed by task handler";

        task.user_id = req.user.sub;
        task.gids = req.user.gids;
        
        //allow admin to override some fields
        if(req.user.scopes.amaretti && ~req.user.scopes.amaretti.indexOf("admin")) {
            if(req.body.user_id) task.user_id = req.body.user_id;
            if(req.body.follow_task_id) task.follow_task_id = req.body.follow_task_id;
        }

        task.resource_ids = [];

        //check access
        async.series([
            next_check=>{
                //check service access
                //I am going to skip checking for service access as it will be checked when the task is submitted
                next_check();
            },

            next_check=>{
                //check instance access
                if(req.user.scopes.amaretti && ~req.user.scopes.amaretti.indexOf("admin")) {
                    return next_check();
                }
                    
                //TODO is this safe if gids happens to contain undefined?
                const gids = task.gids||[];
                if(instance.user_id != task.user_id && !~gids.indexOf(instance.group_id)) {
                    return next_check("don't have access to specified instance");
                }
                next_check();//ok
            },

            next_check=>{
                if(!task.preferred_resource_id) return next_check();
                db.Resource.findById(task.preferred_resource_id, (err, resource)=>{
                    if(err) return next_check(err);
                    if(!resource) return next_check("can't find preferred_resource_id:"+task.preferred_resource_id);
                    if(!common.check_access(req.user, resource)) return next_check("can't access preferred_resource_id:"+task.preferred_resource_id);
                    next_check();//ok
                });
            },

            next_check=>{
                if(task.deps) return next_check();
                //make sure user owns the task
                async.eachSeries(task.deps, (taskid, next_task)=>{
                    db.Task.findById(taskid, (err, dep)=>{
                        if(err) return next_task(err);
                        if(!dep) return next_task("can't find dep task:"+taskid);
                        if(dep.user_id != task.user_id) return next_task("user doesn't own the dep task:"+taskid);
                        if(!~gids.indexOf(dep._group_id)) return next_task("user doesn't have access to the shared instance for dep task:", taskid);
                        next_task();
                    });
                }, next_check);
            }
        ], err=>{
            if(err) return next(err);
            
            //all good - now register!
            task.save((err, _task)=>{
                if(err) return next(err);
                //TODO - I should just return _task - to be consistent with other API
                res.json({message: "Task successfully registered", task: _task});
                events.publish("task.create."+(task._group_id||'ng')+"."+task.user_id+"."+task.instance_id+"."+_task._id, {
                    service: task.service,
                    service_branch: task.service_branch,
                });
                common.update_instance_status(instance_id, err=>{
                    if(err) console.error(err);
                });
            });
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
router.put('/rerun/:task_id', common.jwt(), function(req, res, next) {
    const task_id = req.params.task_id;
    const gids = req.user.gids||[];
    db.Task.findById(task_id, function(err, task) {
        if(err) return next(err);
        if(!task) return res.status(404).end();

        if(!req.user.scopes.amaretti || !~req.user.scopes.amaretti.indexOf("admin")) {
            //non admin!
            if(task.user_id != req.user.sub && !~gids.indexOf(task._group_id)) return res.status(401).end("can't access this task");

            //if rerun by non-admin, reset the user_id
            //if it's admin (like "warehouse"), let's keep the original user_id because it's most likely be done
            //by some administrative reason
            task.user_id = req.user.sub; 
        }

        common.rerun_task(task, req.body.remove_date, err=>{
            if(err) return next(err);
            events.publish("task.rerun."+(task._group_id||'ng')+"."+task.user_id+"."+task.instance_id+"."+task._id, {});
            res.json({message: "Task successfully re-requested", task: task});
            common.update_instance_status(task.instance_id, err=>{
                if(err) console.error(err);
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
router.put('/poke/:task_id', common.jwt(), function(req, res, next) {
    const task_id = req.params.task_id;
    const gids = req.user.gids||[];
    db.Task.findById(task_id, function(err, task) {
        if(err) return next(err);
        if(!task) return res.status(404).end();
        if(!req.user.scopes.amaretti || !~req.user.scopes.amaretti.indexOf("admin")) {
            if(task.user_id != req.user.sub && !~gids.indexOf(task._group_id)) return res.status(401).end("can't access this task");
        }
        task.next_date = undefined;
        if(task.status == "requested") task.start_date = undefined; //for jobs that are stuck while starting
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
router.put('/stop/:task_id', common.jwt(), function(req, res, next) {
    const task_id = req.params.task_id;
    const gids = req.user.gids||[];
    db.Task.findById(task_id, function(err, task) {
        if(err) return next(err);
        if(!task) return res.status(404).end("couldn't find such task id");
        if(!req.user.scopes.amaretti || !~req.user.scopes.amaretti.indexOf("admin")) {
            if(task.user_id != req.user.sub && !~gids.indexOf(task._group_id)) return res.status(401).end("can't access this task");
        }

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
            if(task.start_date) break; //don't stop task that's currently starting
        default:
            task.status = "stopped";
            task.status_msg = "Stopped by user";
        }
        task.save(function(err) {
            if(err) return next(err);
            /*
            common.progress(task.progress_key, {msg: 'Stop Requested'}, function() {
                res.json({message: "Task successfully requested to stop", task: task});
            });
            */
            events.publish("task.stop."+(task._group_id||'ng')+"."+task.user_id+"."+task.instance_id+"."+task._id, {});
            res.json({message: "Task successfully requested to stop", task: task});
            common.update_instance_status(task.instance_id, err=>{
                if(err) console.error(err);
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
router.delete('/:task_id', common.jwt(), function(req, res, next) {
    const task_id = req.params.task_id;
    const gids = req.user.gids||[];

    //remove the task itself
    db.Task.findById(task_id, function(err, task) {
        if(err) return next(err);
        if(!task) return res.status(404).end("couldn't find such task id");
        if(!req.user.scopes.amaretti || !~req.user.scopes.amaretti.indexOf("admin")) {
            if(task.user_id != req.user.sub && !~gids.indexOf(task._group_id)) return res.status(401).end("can't access this task");
        }
        console.log("requesting task removal", task._id);
        common.request_task_removal(task, function(err) {
            if(err) return next(err);

            events.publish("task.remove."+(task._group_id||'ng')+"."+task.user_id+"."+task.instance_id+"."+task._id, {});

            //also remove all followed_task too
            //by removing followed_task - like validator, we prevent subsequent apps to be 
            //submitted using the validator output which might not be exist. user should have
            //good reason why they want to remove the task (maybe it lost the resource access?)
            //so by making the followed task follow it, we prevent it.
            db.Task.find({follow_task_id: task._id}, function(err, followed_tasks) {
                if(err) return next(err);
                async.eachSeries(followed_tasks, function(follow_task, next_task) {
                    console.log("removing followed task", follow_task._id)
                    common.request_task_removal(follow_task, err=>{
                        if(err) return next_task(err);
                        events.publish("task.remove."+(follow_task._group_id||'ng')+"."+follow_task.user_id+"."+follow_task.instance_id+"."+follow_task._id, {});
                        next_task();
                    });
                }, function(err) {
                    if(err) return next(err);

                    //then reply
                    res.json({message: "Task requested for removal."});
                }); 
            });
        }); 
    });
});


/**
 * @api {put} /task/:taskid     Update Task
 * @apiGroup Task
 * @apiDescription              Update a few fields in task that doesn't affect provenance
 *
 * @apiParam {String} [name]    Name for this task
 * @apiParam {String} [desc]    Description for this task
 *
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 *
 */
router.put('/:taskid', common.jwt(), function(req, res, next) {
    const id = req.params.taskid;
    const gids = req.user.gids||[];

    db.Task.findById(id, function(err, task) {
        if(!task) return next("no such task:"+id);
        if(!req.user.scopes.amaretti || !~req.user.scopes.amaretti.indexOf("admin")) {
            if(task.user_id != req.user.sub && !~gids.indexOf(task._group_id)) return res.status(401).end("can't access this task");
        }
        if(req.body.name !== undefined) task.name = req.body.name;
        if(req.body.desc !== undefined) task.desc = req.body.desc;
        //if(req.body.config !== undefined && task.status == "requested") task.config = req.body.config;

        task.update_date = new Date();
        task.save(function(err) {
            if(err) return next(err);
            events.publish("task.update."+(task._group_id||'ng')+"."+task.user_id+"."+task.instance_id+"."+task._id, {});
            res.json(task);
        });
    });
});

module.exports = router;

