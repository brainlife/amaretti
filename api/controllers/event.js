'use strict';

//contrib
const express = require('express');
const router = express.Router();
const winston = require('winston');
const jwt = require('express-jwt');

//mine
const config = require('../../config');
const logger = new winston.Logger(config.logger.winston);

//DEPRECATED
//called by sca-event service to check to see if user should have access to this exchange / key
router.get('/checkaccess/task/:key', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var key = req.params.key;
    var key_tokens = key.split(".");

    var usersub = key_tokens[0];
    if(req.user.sub != usersub) return next("401");
    res.json({status: "ok"});
});

router.get('/checkaccess/user/:sub', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    if(req.user.sub != req.params.sub) return next("401");
    res.json({status: "ok"});
});

module.exports = router;
