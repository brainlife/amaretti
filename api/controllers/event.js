'use strict';

//contrib
var express = require('express');
var router = express.Router();
var winston = require('winston');
var jwt = require('express-jwt');
var async = require('async');
var fs = require('fs');
//var jsonwebtoken = require('jsonwebtoken');

//mine
var config = require('../../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models/db');
var common = require('../common');

function check_task(req, res, next) {
    //task.<user_id>.<instance_id>.<task_id>
    //logger.debug("-----------------------------------------");
    //logger.debug(key_tokens);

    var key = req.params.key;
    var key_tokens = key.split(".");

    var usersub = key_tokens[0];
    if(req.user.sub != usersub) return next("401");
    res.json({status: "ok"});

    /*
    var instid = key_tokens[2];
    db.Instance.findById(instid).exec(function(err, instance) {
        if(err) return next(err);
        if(!instance) return next("404");
        logger.debug(instance.toString());
        if(req.user.sub != instance.user_id) return next("401");
        res.json({status: "ok"});
    });
    */
}

//return event service token for instance
router.get('/checkaccess/task/:key', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var key = req.params.key;
    var key_tokens = key.split(".");
    check_task(req, res, next)
});

module.exports = router;
