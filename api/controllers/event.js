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
    //task.<instance_id>.<task_id>
    //logger.debug("-----------------------------------------");
    //logger.debug(key_tokens);

    var key = req.params.key;
    var key_tokens = key.split(".");

    var instid = key_tokens[1];
    db.Instance.findById(instid).exec(function(err, instance) {
        if(err) return next(err);
        if(!instance) return next("404");
        logger.debug(instance.toString());
        if(req.user.sub != instance.user_id) return next("401");
        /*
        //ok.. issue the token
        jsonwebtoken.sign({
            sub: req.user.sub, 
            exp: (Date.now() + config.events.access_token_ttl)/1000,
            exchange: config.events.exchange,
            keys: ["task."+instid+".#"] //task.<instance_id>.<task_id>
        }, config.events.private_key, config.events.sign_opt, function(err, token) {    
            res.json(token);
        });
        */
        res.json({status: "ok"});
    });
}

//return event service token for instance
router.get('/checkaccess/:key', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var key = req.params.key;
    var key_tokens = key.split(".");
    var event_type = key_tokens[0];
    switch(event_type) {
    case "task":
        check_task(req, res, next)
        break;
    default:
        res.json({msg: "unknown event type:"+event_type});
    }
});

module.exports = router;
