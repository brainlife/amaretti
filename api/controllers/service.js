'use strict';

//contrib
var express = require('express');
var router = express.Router();
var winston = require('winston');
var jwt = require('express-jwt');
var async = require('async');
var fs = require('fs');
var request = require('request');

//mine
var config = require('../../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models/db');
const service = require('../service');

/**
 * @api {get} /service          Query Services
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
 *
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
 * @apiGroup Service
 * @api {post} /service    Register Service
 * @apiParam {String} giturl  
 *                          Github URL to register service (like https://github.com/soichih/sca-service-life)
 * @apiDescription          From specified Github URL, this API will register new service using github repo info 
 *                          and package.json. You can not re-register already register service
 * 
 * @apiHeader {String} authorization 
 *                          A valid JWT token "Bearer: xxxxx"
 *
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

    var service_name = owner+"/"+repo;
    service.loaddetail(service_name, function(err, service_detail) {
        if(err) return next(err);

        //see if the service is already registered
        db.Service.findOne({name: service_name}, function(err, service) {
            if(err) return next(err);
            if(service) {
                return next("service is already registered");
            }
            service_detail.user_id = req.user.sub;
            service = new db.Service(service_detail);
            service.save(function(err, _s) {
                if(err) return next(err);
                res.json(_s);
            });
        });
    });
});

module.exports = router;

