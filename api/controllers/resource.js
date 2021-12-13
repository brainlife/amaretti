'use strict';

//node
const fs = require('fs');
const child_process = require('child_process');

//contrib
const express = require('express');
const router = express.Router();
const winston = require('winston');
const async = require('async');
const path = require('path');
const mime = require('mime');
const request = require('request');

//mine
const config = require('../../config');
const logger = winston.createLogger(config.logger.winston);
const db = require('../models');
const common = require('../common');
const resource_lib = require('../resource');
const transfer = require('../transfer');
const mongoose = require('mongoose');

function mask_enc(resource) {
    //mask all config parameters that starts with enc_
    for(var k in resource.config) {
        if(k.indexOf("enc_") === 0) {
            resource.config[k] = true;
        }
    }
    return resource;
}

function is_admin(user) {
    if(user.scopes.amaretti && ~user.scopes.amaretti.indexOf("admin")) return true;
    return false;
}

function canedit(user, resource) {
    if(!user) return false;
    if(resource.user_id == user.sub) return true;
    if(resource.admins && resource.admins.includes(user.sub.toString())) return true;
    if(is_admin(user)) return true;
    return false;
}

/**
 * @apiGroup Resource
 * @api {get} /resource         Query resource registrations
 * @apiDescription              Returns all resource registration instances that user has access to
 *
 * @apiParam {Object} [find]    Optional Mongo query to perform
 * @apiParam {Object} [sort]    Mongo sort object - defaults to _id. Enter in string format like "-name%20desc"
 * @apiParam {String} [select]  Fields to load - defaults to 'logical_id'. Multiple fields can be entered with %20 as delimiter
 * @apiParam {Number} [limit]   Maximum number of records to return - defaults to 100
 * @apiParam {Number} [skip]    Record offset for pagination (default to 0)
 * @apiParam {String} [user_id] (Only for amaretti:admin) Override user_id to search (default to sub in jwt). Set it to null if you want to query all users.
 *
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object}         List of resources (maybe limited / skipped) and total number of resources
 */
router.get('/', common.jwt(), function(req, res, next) {
    var find = {};
    if(req.query.find || req.query.where) find = JSON.parse(req.query.find || req.query.where);
    if(req.query.limit) req.query.limit = parseInt(req.query.limit);
    if(req.query.skip) req.query.skip = parseInt(req.query.skip);

    //if(!is_admin(req.user) || find.user_id === undefined) {
    const gids = req.user.gids||[];
    gids.push(config.amaretti.globalGroup);
    find["$or"] = [
        {user_id: req.user.sub.toString()},
        {admins: req.user.sub.toString()},
        {gids: {"$in": gids}},
    ];
    /*} else if(find.user_id == null) {
        //admin can set it to null and remove user_id / gids filtering
        //html get method won't allow empty parameter, so by setting it to null, then I can replace with *undefined*
        delete find.user_id;
    }*/

    let select = null; //select all by default
    if(req.query.select) select = req.query.select+" user_id"; //we need user_id at least

    db.Resource.find(find)
    .select(select)
    .limit(req.query.limit || 100)
    .skip(req.query.skip || 0)
    .sort(req.query.sort)
    .lean()
    .exec(function(err, resources) {
        if(err) return next(err);
        resources.forEach(mask_enc);

        //add / remove a few more things
        resources.forEach(function(resource) {
            resource.salts = undefined;
            resource._canedit = canedit(req.user, resource)
        });

        //deprecate this..
        db.Resource.countDocuments(find).exec(function(err, count) {
            if(err) return next(err);
            res.json({resources: resources, count: count});
        });
    });
});

/**
 * @apiGroup Resource
 * @api {get} /resource/best    Find best resource
 * @apiDescription              Return a best resource to run specified service using algorithm used by sca-wf-task
 *                              when it determines which resource to use for a task request
 *
 * @apiParam {String} service   Name of service to run (like "soichih/sca-service-life")
 * @apiParam {Number[]} gids    gids to query resources 
 * @apiHeader {String} authorization
 *                              A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccessExample {json} Success-Response:
 *                              {
 *                              score: 10, 
 *                              resource: <resourceobj>, 
 *                              considered: {...}, 
 *                              _detail: <resourcedetail>, 
 *                              workdir: <workdir>,
 *                              _canedit: true,
 *                              }
 */
router.get('/best', common.jwt(), (req, res, next)=>{
    //create a fake task to query resource
    const task = {
        service: req.query.service,
    };

    //make sure user has access to requested gids
    if(req.query.gids) task.gids = req.query.gids.map(gid=>parseInt(gid)).filter(gid=>{
        if(gid == config.amaretti.globalGroup) return true; //user can select from public resource
        if(req.user.gids.includes(gid)) return true; //group member can selec it
        return false;
    });

    //if(req.query.service) task.service = req.query.service;
    resource_lib.select(req.user, task, (err, resource, score, considered)=>{
        if(err) return next(err);
        if(!resource) return res.json({nomatch: true, considered});
        res.json({
            score,
            resource: mask_enc(resource),
            considered,
            workdir: common.getworkdir(null, resource),
            _canedit: canedit(req.user, resource),
        });
    });
});

//return a list of tasks submitted on this resource recently
//client ui > warehouse/resource.vue
router.get('/tasks/:resource_id', common.jwt(), async (req, res, next)=>{

    console.log(new Date(), "loading recent");
    let recent = await db.Task.find({
        resource_id: req.params.resource_id,
        status: {$nin: ["removed", "stopped", "running", "running_sync", "requested"]},
    }).lean()
    .select('_id user_id _group_id service service_branch status status_msg create_date request_date start_date finish_date fail_date')
    .sort({create_date: -1})
    .limit(100)
    .exec()
    
    console.log(new Date(), "loading running");
    let running = await db.Task.find({
        resource_id: req.params.resource_id,
        status: {$in: ["running", "running_sync"/*, "requested"*/]},
    }).lean()
    .select('_id user_id _group_id service service_branch status status_msg create_date request_date start_date finish_date fail_date')
    .sort({create_date: -1})
    .exec()

    //also look for tasks that are transitioning from requested to running
    console.log(new Date(), "loading starting");
    let starting = await db.Task.find({
        resource_id: req.params.resource_id,
        status: "requested",
        start_date: {$exists: true},
    }).lean()
    .select('_id user_id _group_id service service_branch status status_msg create_date request_date start_date finish_date fail_date')
    .sort({create_date: -1})
    .exec()

    running = [...starting, ...running];

    console.log(new Date(), "output json");
    res.json({recent, running});
});

/**
 * @api {put} /resource/test/:resource_id Test resource
 * @apiName TestResource
 * @apiGroup Resource
 *
 * @apiDescription Test resource connectivity and availability. Store status on status/status_msg fields of the resource entry
 *
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 * @apiSuccessExample {json} Success-Response:
 *     HTTP/1.1 200 OK
 *     {
 *         "status": "ok"
 *     }
 *
 * @apiErrorExample {json} Error-Response:
 *     HTTP/1.1 500 OK
 *     {
 *         "message": "SSH connection failed"
 *     }
 *
 */
router.put('/test/:id', common.jwt(), function(req, res, next) {
    var id = req.params.id;
    db.Resource.findOne({_id: id}, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end();
        //if(!common.check_access(req.user, resource)) return res.status(401).send({message: "can't access"});
        if(!canedit(req.user, resource)) return res.status(401).send({message: "you have to have write access to check"});
        resource_lib.check(resource, function(err, ret) {
            if(err) return next(err);
            res.json(ret);
        });
    });
});

/**
 * @api {put} /resource/:id       Update resource configuration
 * @apiName UpdateResource
 * @apiGroup Resource
 *
 * @apiParam {String} id          Resource Instance ID to update
 *
 * @apiParam {Object} [config]    Resource Configuration to update
 * @apiParam {Object} [envs]      Resource environment parameters to update
 * @apiParam {String} [name]      Name of this resource instance
 * @apiParam {String} [avatar]    Avatar URL path
 * @apiParam {String} [hostname]  Hostname to override the resource base hostname
 * @apiParam {Object[]} [services] Array of name: and score: to add to the service provides on resource base
 * @apiParam {Number[]} [gids]    List of groups that can use this resource (only amaretti admin can update)
 * @apiParam {Boolean} [active]   Set true to enable resource
 *
 * @apiDescription Update the resource instance (only the resource that user owns)
 *
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 * @apiSuccess {Object} Resource Object
 *
 */

function getAdminGids(user) {
    //pull out admin gids from req.user.gids (before null)
    //TODO - we should store adminGids and memberGids separately in jwt, but I'd like to 
    //gradually migrate. storing gids as well as admin/memberGids temporarily doubles the number
    //of IDS to store, and it becomes too large for HTTP header. We should probably query 
    //gids from the auth API each time.
    const adminGids = [];
    for(const gid of user.gids) {
        if(gid === null) break;
        adminGids.push(gid);
    }
    return adminGids;
}

router.put('/:id', common.jwt(), function(req, res, next) {
    var id = req.params.id;
    db.Resource.findOne({_id: id}, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end();
        if(!canedit(req.user, resource)) return res.status(401).end();

        //check to make sure requested gids are user's admin
        if(req.body.gids) {
            const adminGids = getAdminGids(req.user);
            req.body.gids = req.body.gids.filter(gid=>{
                if(adminGids.includes(gid)) return true; //admin can add its own gid
                if(gid == config.amaretti.globalGroup) {
                    if(is_admin(req.user)) return true; //only admin can *add* global group
                    if(resource.gids.includes(config.amaretti.globalGroup)) return true; //if already set, keep it
                }
            });
        }

        //need to decrypt first so that I can preserve previous values
        common.decrypt_resource(resource);

        //keep old value if enc_ fields are set to true
        for(var k in req.body.config) {
            if(k.indexOf("enc_") === 0) {
                var v = req.body.config[k];
                if(v === true) {
                    req.body.config[k] = resource.config[k];
                }
            }
        }

        //decrypt again and save
        common.encrypt_resource(req.body);
        db.Resource.update({_id: id}, { $set: req.body }, {new: true}, function(err) {
            if(err) return next(err);
            mask_enc(req.body);
            res.json(req.body);
        });
    });
});

//it's dangerous to allow anyone to share resources with any groups.
//task could get submitted there without other user's being aware..
//for now, only administrators can update gids

/**
 * @api {post} /resource        Register new resource configuration
 * @apiName NewResource
 * @apiGroup Resource
 *
 * @apiParam {Object} config    Configuration for resource
 * @apiParam {Object} [envs]    Key values to be inserted for service execution
 * @apiParam {String} [name]    Name of this resource instance (like "soichi's karst account")
 * @apiParam {String} [avatar]  Avatar URL
 * @apiParam {String} [hostname]  Hostname to override the resource base hostname
 * @apiParam {Object[]} [services] Array of name: and score: to add to the service provides on resource base
 * @apiParam {Number[]} [gids]  List of groups that can use this resource (user must be admin of the group)
 * @apiParam {String[]} [admins]  List of subs who can administer this resource
 * @apiParam {Boolean} [active] Set true to enable resource
 *
 * @apiDescription Just create a DB entry for a new resource - it doesn't test resource / install keys, etc..
 *
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 * @apiSuccessExample {json} Success-Response:
 *     HTTP/1.1 200 OK
 *     { __v: 0,
 *      user_id: '9',
 *      gids: [1,2,3],
 *      type: 'ssh',
 *      resource_id: 'karst',
 *      name: 'use foo\'s karst account',
 *      config:
 *       { ssh_public: 'my public key',
 *         enc_ssh_private: true,
 *         username: 'hayashis' },
 *      _id: '5758759710168abc3562bf01',
 *      update_date: '2016-06-08T19:44:23.205Z',
 *      create_date: '2016-06-08T19:44:23.204Z',
 *      active: true }
 *
 */

router.post('/', common.jwt(), function(req, res, next) {

    if(!req.user.scopes.amaretti || !~req.user.scopes.amaretti.indexOf("resource.create")) 
        return next("you are not authorized to register new resource. please contact admin");

    //check to make sure requested gids are user's admin
    if(req.body.gids) {
        const adminGids = getAdminGids(req.user);
        req.body.gids = req.body.gids.filter(gid=>{
            if(adminGids.includes(gid)) return true;
            if(gid == config.amaretti.globalGroup && is_admin(req.user)) return true; //admin can *add* global group
        });
    }

    var resource = new db.Resource(req.body);
    resource.user_id = req.user.sub;
    delete resource._id; //sometimes client sets this to null.. it shouldn't, but let's be nice

    //first save..
    resource.save().then(_resource=>{
        //I have to save twice because we can't encrypt enc_ fields without _id set first
        common.encrypt_resource(_resource);
        _resource.markModified('config');
        return _resource.save();
    }).then(_final_resource=>{
        var resource = _final_resource.toObject();
        resource._canedit = canedit(req.user, resource);
        res.json(mask_enc(resource));
    }).catch(next);
});

/**
 * @api {delete} /resource/:id Remove resource configuration
 * @apiName RemoveResource
 * @apiGroup Resource
 *
 * @apiParam {String} id Resource ID
 * @apiDescription Remove resource by setting its status to "removed"
 *
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 * @apiSuccess {String} ok
 *
 */
router.delete('/:id', common.jwt(), function(req, res, next) {
    var id = req.params.id;
    db.Resource.findOne({_id: id}, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end("couldn't find such resource");
        if(!canedit(req.user, resource)) return res.status(401).end("you don't have access to this resource");
        resource.status = "removed";
        resource.save(err=>{
            if(err) return next(err);
            res.json({status: 'ok'});
        });
    });
});

//(admin only) allow other service (warehouse) to directly access storage resource's data
router.get('/archive/download/:id/*', common.jwt(), function(req, res, next) {
    logger.debug("requested");
    if(!is_admin(req.user)) return next("admin only");
    let path = req.params[0];

    //sometime request gets canceled, and we need to know about it to prevent ssh connections to get stuck
    //only thrown if client terminates request (including no change?)
    let req_closed = false;
    req.on('close', ()=>{
        logger.debug("req/close");
        req_closed = true;
    });

    logger.debug("loading resource detail"+req.params.id);
    db.Resource.findOne({_id: req.params.id}, function(err, resource) {
        if(err) return next(err);
        if(!resource) return next("no such resource");
        if(!resource.envs || !resource.envs.BRAINLIFE_ARCHIVE) return next("BRAINLIFE_ARCHIVE ENV param is not set");
        logger.debug("opening sftp connection to resource");
        if(req_closed) return next("request already closed.. bailing 1");
        common.get_sftp_connection(resource, function(err, sftp) {
            if(err) return next(err);
            logger.debug("opening sftp connection to resource");
            if(req_closed) return next("request already closed.. bailing 2");
            const fullpath = resource.envs.BRAINLIFE_ARCHIVE+"/"+path;
            logger.debug("using fullpath %s", fullpath);
            sftp.createReadStream(fullpath, (err, stream)=>{
                if(err) return next(err);
                //in case user terminates in the middle.. read stream doesn't raise any event!
                if(req_closed) return stream.close();
                req.on('close', ()=>{
                    logger.info("request closed........ closing sftp stream also");
                    stream.close();
                });
                stream.pipe(res);
            });
        });
    });
});

/**
 * @api {get} /resource/usage/:id Load resource usage graph
 * @apiName ResourceUsage
 * @apiGroup Resource
 *
 * @apiParam {String} id          Resource Instance ID to update
 *
 * @apiDescription  Download resource usage grraph
 *
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 * @apiSuccess {Object} Resource Object
 *
 */
router.get('/usage/:resource_id', common.jwt(), (req, res, next)=>{
    //check access
    db.Resource.findOne({_id: req.params.resource_id}, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end();

        if(!common.canUseResource(req.user, resource)) return res.status(401).send({messasge: "you can't access this resource"});

        //load usage graph
        let days = 30;
        request.get({url: config.metrics.api+"/render", qs: {
            target: config.metrics.resource_prefix+"."+req.params.resource_id,
            from: "-"+days+"day",
            format: "json",
            noNullPoints: "true"
        }, json: true, debug: true }, (err, _res, json)=>{
            if(err) return next(err);
            let data;
            if(json.length == 0) data = []; //maybe never run?
            else data = json[0].datapoints;

            //aggregate graph into every few hours
            let window = 3600*3;
            let start = new Date();
            let max = parseInt(start.getTime()/1000);
            start.setDate(start.getDate()-days);
            let min = parseInt(start.getTime()/1000);
            let recent_job_counts = [];
            for(let d = min;d < max;d+=window) {
                let sum = 0;
                let count = 0;
                data.forEach(point=>{
                    //if(point[1] > d && point[1] < d+window && point[0] > max_value) max_value = point[0];
                    if(point[1] > d && point[1] < d+window) {
                        sum+=point[0];
                        count++;
                    }
                });
                let avg = 0;
                if(count > 0) avg = sum/count;
                recent_job_counts.push([d, avg]); 
            }

            res.json(recent_job_counts);
        });
    });
});

module.exports = router;

