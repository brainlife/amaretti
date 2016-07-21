'use strict';

//contrib
var express = require('express');
var router = express.Router();
var winston = require('winston');
var jwt = require('express-jwt');
var async = require('async');
var fs = require('fs');
var ejs = require('ejs');
var request = require('request');

//mine
var config = require('../../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models/db');

/**
 * @api {get} /service          GetService
 * @apiGroup                    Service
 * @apiDescription              Query for SCA services 
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
    if(req.query.find) find = JSON.parse(req.query.find);
    //find.user_id = req.user.sub; //always set this
    //logger.debug(find);

    db.Service.find(find)
    .select(req.query.select || 'name user_id register_date pkg git.clone_url git.description')
    .limit(req.query.limit || 100)
    .skip(req.query.skip || 0)
    .sort(req.query.sort || '_id')
    .exec(function(err, services) {
        if(err) return next(err);
        db.Service.count(find).exec(function(err, count) {
            if(err) return next(err);
            res.json({services: services, count: count});
        });
    });
});

/**
 * @api {post} /service    NewService
 * @apiParam {String} giturl  Github URL to register service (like https://github.com/soichih/sca-service-life)
 * @apiDescription  From specified Github URL, this API will register new service using github repo info and package.json
 * @apiGroup Service
 * 
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 * @apiSuccessExample {json} Success-Response:
 *     HTTP/1.1 200 OK
 *     {
 *         "__v": 0,
 *         "user_id": "1",
 *         "name": "soichih/sca-service-life",
 *         "git": {...},
 *         "pkg": {...},
 *         "register_date": "2016-05-26T14:14:51.526Z"
 *     }
 *
 * @apiErrorExample {json} Error-Response:
 *     HTTP/1.1 500 OK
 *     {
 *         "code": 11000,
 *         "index": 0,
 *         "errmsg": "insertDocument :: caused by :: 11000 E11000 duplicate key error index: sca.services.$name_1  dup key: { : \"soichih/sca-service-life\" }",
 *         ...
 *     }
 *
 */
router.post('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var giturl = req.body.giturl;

    if(giturl.indexOf("https://") == 0) {
        
        //remove trailing .git if it exists
        if(giturl.endsWith(".git")) {
            giturl = giturl.substr(0, giturl.length-4);
        }
        
        //parse giturl 
        var giturl_tokens = giturl.split("/");
        //var schema = giturl_tokens[0]; //https
        var domain = giturl_tokens[2]; //github.com
        if(domain != "github.com") return next("Currently only supports github.com");
        var owner = giturl_tokens[3]; //soichih
        var repo = giturl_tokens[4]; //sca-service-life
    } else if(giturl.indexOf("git@") == 0) {
        var segments = giturl.split(":");
        var user_domain = segments[0]; //git@github.com
        if(user_domain != "git@github.com") return next("Currently only supports github.com");
        var owner_repo = segments[1].split("/"); //soichih/sca-wf-qr.git
        var owner = owner_repo[0]; //soichih
        var repo_git = owner_repo[1]; //sca-wf-qr.git
        var repo = repo_git.split(".")[0];
    } else {
        return next("Don't know how to parse :"+giturl);
    }

    //first load the git repo json
    request('https://api.github.com/repos/'+owner+'/'+repo, {
        json: true, headers: {'User-Agent': 'IU/SciApt/SCA'}, //required by github
    }, function(err, _res, git) {
        if(err) return next(err);
        //console.dir(git.clone_url);
        if(_res.statusCode != 200) return next("failed to query requested repo. code:"+_res.statusCode);
        
        //then load package.json
        //TODO - should I always use master - or let user decide?
        request('https://raw.githubusercontent.com/'+owner+'/'+repo+'/master/package.json', {
            json: true, headers: {'User-Agent': 'IU/SciApt/SCA'}, //required by github
        }, function(err, _res, pkg) {
            if(err) return next(err);
            //console.dir(pkg);
            var service_name = owner+"/"+repo;
            var detail = {
                user_id: req.user.sub,
                giturl: giturl,
                name: service_name,
                git: git,
                pkg: pkg,
            };
            db.Service.findOne({name: service_name}, function(err, service) {
                if(err) return next(err);

                //allow user to re-register.
                //TODO - once we implement mechanism to update registration info automatically,
                //we shouldn't have to allow re-register
                if(service) {
                    if(service.user_id != req.user.sub) return next("The service: "+service_name+ " is already registered by user sub:"+req.user.sub+". Only the original registrar can re-register");
                    //update
                    logger.info("updating service");
                    service.git = git; 
                    service.pkg = pkg; 
                    //service.giturl = giturl;  
                } else {
                    service = new db.Service(detail);
                }

                service.save(function(err, _s) {
                    if(err) return next(err);
                    res.json(_s);
                });
            });
        });
        
    });
});

/*
router.get('/:workflowid', function(req, res, next) {
    res.json(config.workflows[req.params.workflowid]);
});
*/

module.exports = router;

