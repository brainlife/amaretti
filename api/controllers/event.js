'use strict';

//contrib
const express = require('express');
const router = express.Router();
const winston = require('winston');
const jwt = require('express-jwt');

//mine
const config = require('../../config');
const logger = winston.createLogger(config.logger.winston);
const db = require('../models');

/*
//DEPRECATED
//called by sca-event service to check to see if user should have access to this exchange / key
router.get('/checkaccess/task/:key', jwt({secret: config.amaretti.auth_pubkey}), function(req, res, next) {
    var key = req.params.key;
    var key_tokens = key.split(".");

    var usersub = key_tokens[0];
    if(req.user.sub != usersub) return next("401");
    res.json({status: "ok"});
});
*/

/*DEPRECATED also..
router.get('/checkaccess/user/:sub', jwt({secret: config.amaretti.auth_pubkey}), function(req, res, next) {
    if(req.user.sub != req.params.sub) return next("401");
    res.json({status: "ok"});
});
*/

router.get('/checkaccess/instance/:id', jwt({secret: config.amaretti.auth_pubkey}), function(req, res, next) {
    let instid = req.params.id;
    db.Instance.findOne({
        _id: instid, 
        '$or': [
            {user_id: req.user.sub},
            {group_id: {$in: req.user.gids||[]}},
        ]
    }, function(err, instance) {
        if(err) return next(err);
        if(!instance) res.status(401).end("no such instance or you don't have access to it");
        res.json({status: "ok"});
    });
});

module.exports = router;
