'use strict';

//node
const fs = require('fs');
const child_process = require('child_process');

//contrib
const express = require('express');
const router = express.Router();
const winston = require('winston');
const jwt = require('express-jwt');
const async = require('async');
const path = require('path');
const multiparty = require('multiparty');
const mime = require('mime');
const request = require('request');

//mine
const config = require('../../config');
const logger = new winston.Logger(config.logger.winston);
const db = require('../models');
const common = require('../common');
const resource_lib = require('../resource');
const transfer = require('../transfer');

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
    if(user.scopes.sca && ~user.scopes.sca.indexOf("admin")) return true; //deprecate (use scopes.amaretti)
    if(user.scopes.amaretti && ~user.scopes.amaretti.indexOf("admin")) return true;
    return false;
}

function canedit(user, resource) {
    if(!user) return false;
    if(resource.user_id == user.sub) return true;
    if(is_admin(user)) return true;
    return false;
}

/**
 * @apiGroup Resource
 * @api {get} /resource/types   Get all resource types
 * @apiDescription              Returns all resource types configured on the server
 *
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object}         List of resources types (in key/value where key is resource type ID, and value is resource detail)
 */
router.get('/types', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    res.json(config.resources);
});

router.get('/stats/:resource_id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    //check access
    db.Resource.findOne({_id: req.params.resource_id}, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end();
        if(!resource.active) return res.status(401).json({message: "resource not active"});
        if(!common.check_access(req.user, resource)) return res.status(401).end();
        resource_lib.stat(resource, function(err, stats) {
            if(err) return next(err);
            res.json(stats);
        });
    });
});

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
 * @apiParam {String} [user_id] (Only for sca:admin) Override user_id to search (default to sub in jwt). Set it to null if you want to query all users.
 *
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object}         List of resources (maybe limited / skipped) and total number of resources
 */
router.get('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var find = {};
    if(req.query.find || req.query.where) find = JSON.parse(req.query.find || req.query.where);
    if(req.query.limit) req.query.limit = parseInt(req.query.limit);
    if(req.query.skip) req.query.skip = parseInt(req.query.skip);

    if(!is_admin(req.user) || find.user_id === undefined) {
        //search only resource that user owns or shared with the user
        var gids = req.user.gids||[];
        gids = gids.concat(config.amaretti.global_groups);
        find["$or"] = [
            {user_id: req.user.sub},
            {gids: {"$in": gids}},
        ];
    } else if(find.user_id == null) {
        //admin can set it to null and remove user_id / gids filtering
        //html get method won't allow empty parameter, so by setting it to null, then I can replace with *undefined*
        delete find.user_id;
    }

    db.Resource.find(find)
    .select(req.query.select)
    .limit(req.query.limit || 100)
    .skip(req.query.skip || 0)
    .sort(req.query.sort || '_id')
    .lean()
    .exec(function(err, resources) {
        if(err) return next(err);
        resources.forEach(mask_enc);

        //add / remove a few more things
        resources.forEach(function(resource) {
            //resource.detail = config.resources[resource.resource_id]; //TODO deprecate this
            resource._detail = config.resources[resource.resource_id];
            resource.salts = undefined;
            resource._canedit = canedit(req.user, resource)
        });
        db.Resource.count(find).exec(function(err, count) {
            if(err) return next(err);
            res.json({resources: resources, count: count});
        });
    });
});

//http://locutus.io/php/strings/addslashes/
String.prototype.addSlashes = function() {
  //  discuss at: http://locutus.io/php/addslashes/
  // original by: Kevin van Zonneveld (http://kvz.io)
  // improved by: Ates Goral (http://magnetiq.com)
  // improved by: marrtins
  // improved by: Nate
  // improved by: Onno Marsman (https://twitter.com/onnomarsman)
  // improved by: Brett Zamir (http://brett-zamir.me)
  // improved by: Oskar Larsson Högfeldt (http://oskar-lh.name/)
  //    input by: Denny Wardhana
  //   example 1: addslashes("kevin's birthday")
  //   returns 1: "kevin\\'s birthday"
  return this.replace(/[\\"']/g, '\\$&').replace(/\u0000/g, '\\0')
}

/**
 * @apiGroup Resource
 * @api {get} /resource/best    Find best resource
 * @apiDescription              Return a best resource to run specified service using algorithm used by sca-wf-task
 *                              when it determines which resource to use for a task request
 *
 * @apiParam {String} [service] Name of service to run (like "soichih/sca-service-life")
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
router.get('/best', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    logger.debug("choosing best resource for service:"+req.query.service);

    var query = {};
    if(req.query.service) query.service = req.query.service;
    resource_lib.select(req.user, query, function(err, resource, score, considered) {
        if(err) return next(err);
        if(!resource) return res.json({nomatch: true, considered});
        var resource_detail = config.resources[resource.resource_id];
        res.json({
            score,
            resource: mask_enc(resource),
            considered,
            detail: resource_detail, //TODO deprecate this
            _detail: resource_detail,
            workdir: common.getworkdir(null, resource),
            _canedit: canedit(req.user, resource),
        });
    });
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
router.put('/test/:id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.id;
    db.Resource.findOne({_id: id}, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end();
        if(!common.check_access(req.user, resource)) return res.status(401).send({message: "can't access"});
        logger.info("testing resource:"+id);
        resource_lib.check(resource, function(err, ret) {
            if(err) return next(err);
            res.json(ret);
        });
    });
});

/**
 * @api {put} /resource/:id     Update resource configuration
 * @apiName UpdateResource
 * @apiGroup Resource
 *
 * @apiParam {String} id        Resource Instance ID to update
 *
 * @apiParam {Object} [config]    Resource Configuration to update
 * @apiParam {Object} [envs]      Resource environment parameters to update
 * @apiParam {String} [name]      Name of this resource instance
 * @apiParam {String} [hostname]  Hostname to override the resource base hostname
 * @apiParam {Object[]} [services] Array of name: and score: to add to the service provides on resource base
 * @apiParam {Number[]} [gids]    List of groups that can use this resource (only sca admin can update)
 * @apiParam {Boolean} [active]   Set true to enable resource
 *
 * @apiDescription Update the resource instance (only the resource that user owns)
 *
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 * @apiSuccess {Object} Resource Object
 *
 */
router.put('/:id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.id;
    db.Resource.findOne({_id: id}, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end();
        //if(resource.user_id != req.user.sub) return res.status(401).end();
        if(!canedit(req.user, resource)) return res.status(401).end();

        //only admin can update gids
        if(!req.user.scopes.sca || !~req.user.scopes.sca.indexOf("admin")) {
            delete resource.gids;
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
 * @apiParam {String} type      "hpss", or "ssh" for now
 * @apiParam {String} resource_id ID of this resource instance ("karst", "mason", etc..)
 * @apiParam {Object} config    Configuration for resource
 * @apiParam {Object} [envs]    Key values to be inserted for service execution
 * @apiParam {String} [name]    Name of this resource instance (like "soichi's karst account")
 * @apiParam {String} [hostname]  Hostname to override the resource base hostname
 * @apiParam {Object[]} [services] Array of name: and score: to add to the service provides on resource base
 * @apiParam {Number[]} [gids]  List of groups that can use this resource (only sca admin can enter this)
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
router.post('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var resource = new db.Resource(req.body);

    //only admin can update gids
    if(!req.user.scopes.sca || !~req.user.scopes.sca.indexOf("admin")) {
        delete resource.gids;
    }

    resource.user_id = req.user.sub;
    common.encrypt_resource(resource);
    resource.save(function(err, _resource) {
        if(err) return next(err);
        var _resource = JSON.parse(JSON.stringify(_resource));
        _resource._canedit = canedit(req.user, resource);
        res.json(mask_enc(_resource));
    });
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
router.delete('/:id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.id;
    db.Resource.findOne({_id: id}, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end("couldn't find such resource");
        //if(resource.user_id != req.user.sub) return res.status(401).end("you don't own this resource");
        if(!canedit(req.user, resource)) return res.status(401).end("you don't have access to this resource");
        resource.status = "removed";
        resource.save(err=>{
            if(err) return next(err);
            res.json({status: 'ok'});
        });
        /*
        resource.remove(function(err) {
            if(err) return next(err);
            console.log("done removing");
            res.json({status: 'ok'});
        });
        */
    });
});

/**
 * @api {get} /resource/gensshkey Generate ssh key pair
 * @apiName GENSSHKEYResource
 * @apiGroup Resource
 *
 * @apiDescription
 *      Used by resource editor to setup new resource
 *      jwt is optional.. since it doesn't really store this anywhere (should I?)
 *      kdinstaller uses this to generate key (and scott's snapshot tool)
 *      In the future, this might be moved to a dedicated service (or deprecated)
 *
 * //@apiHeader {String} [authorization] A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccessExample {json} Success-Response:
 *     HTTP/1.1 200 OK
 *     { pubkey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDDxtMlosV+/5CutlW3YIO4ZomH6S0+3VmDlAAYvBXHD+ut4faGAZ4XuumfJyg6EAu8TbUo+Qj6+pLuYLcjqxl2fzI6om2SFh9UeXkm1P0flmgHrmXnUJNnsnyen/knJtWltwDAZZOLj0VcfkPaJX7sOSp9l/8W1+7Qb05jl+lzNKucpe4qInh+gBymcgZtMudtmurEuqt2eVV7W067xJ7P30PAZhZa7OwXcQrqcbVlA1V7yk1V92O7Qt8QTlLCbszE/xx0cTEBiSkmkvEG2ztQQl2Uqi+lAIEm389quVPJqjDEzaMipZ1X5xgfnyDtBq0t/SUGZ8d0Ki1H0jmU7H//',
 *       key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAKCAQEAw8 ... CeSZ6sKiQmE46Yh4/zyRD4JgW4CY=\n-----END RSA PRIVATE KEY-----' }
 *
router.get('/gensshkey', jwt({secret: config.sca.auth_pubkey, credentialsRequired: false}), function(req, res, next) {
    common.ssh_keygen({
        //ssh-keygen opts (https://github.com/ericvicenti/ssh-keygen)
        destroy: true,
        comment: req.query.comment,
        password: req.query.password,
    }, function(err, out) {
        if(err) return next(err);
        res.json(out);
    });
});
*/

//intentionally left undocumented
//TODO - I should limit access to certain IP range
//currently only used by DAART
router.post('/installsshkey', function(req, res, next) {
    var username = req.body.username;
    var password = req.body.password;
    var host = req.body.hostname || req.body.host;
    var pubkey = req.body.pubkey;
    var comment = req.body.comment;

    if(username === undefined) return next("missing username");
    if(password === undefined) return next("missing password");
    if(host === undefined) return next("missing hostname");
    if(pubkey === undefined) return next("missing pubkey");
    if(comment === undefined) return next("missing comment");

    var command = 'wget --no-check-certificate https://raw.githubusercontent.com/soichih/sca-wf/master/bin/install_pubkey.sh -O - | PUBKEY=\"'+pubkey.addSlashes()+'\" COMMENT=\"'+comment.addSlashes()+'\" bash';
    //var command = 'wget --no-check-certificate https://raw.githubusercontent.com/soichih/sca-wf/master/bin/install_pubkey.sh -O - | bash';
    common.ssh_command(username, password, host, command, {
        /* karst sshd doesn't allow ssh client env
        env: {
            PUBKEY: pubkey,
            comment: comment,
        }
        */
    }, function(err) {
        if(err) return next(err);
        res.json({message: 'ok'});
    });
});

/*
//intentionally left undocumented
router.post('/setkeytab/:resource_id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var resource_id = req.params.resource_id;
    var username = req.body.username;
    var password = req.body.password;

    if(username === undefined) return next("missing username");
    if(password === undefined) return next("missing password");

    db.Resource.findById(resource_id, function(err, resource) {
        if(err) return next(err);
        //console.dir(resource);
        if(!resource) return res.status(404).json({message: "couldn't find the resource specified"});
        if(!common.check_access(req.user, resource)) return res.status(401).end();
        if(resource.type != "hpss") return res.status(404).json({message: "not a hpss resource"});
        if(resource.status != "ok") return res.status(500).json({message: resource.status_msg});

        //need to decrypt first..
        common.decrypt_resource(resource);

        resource.config.auth_method = "keytab";
        resource.config.username = username;

        child_process.exec(__dirname+"/../../bin/gen_keytab.sh", {
            env: {
                USERNAME: username,
                PASSWORD: password,
            }
        }, function(err, stdout, stderr) {
            if(err) return next(err); //exit 1 will be handled here
            resource.config.enc_keytab = stdout.trim();

            //decrypt again and save
            common.encrypt_resource(resource);
            resource.save(function(err) {
                if(err) return next(err);
                res.json({message: 'ok'});
            });
        })
    });
});
*/

module.exports = router;

