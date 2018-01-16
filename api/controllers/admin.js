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

//return list of services currently running and counts for each
router.get('/services/running', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {

    //admin only
    if(!req.user.scopes.amaretti || !~req.user.scopes.amaretti.indexOf("admin")) return next("admin only");
    
    //group by status and count
    db.Task.aggregate([
        {$match: {status: {$in: ["running"/*, "requested"*/]}}},//requested / waiting shouldn't be counted?
        {$group: {_id: {service: '$service', resource_id: '$resource_id'}, count: {$sum: 1}}},
    ]).exec(function(err, services) {
        if(err) return next(err);
        res.json(services);
    });
});

/*
//return list of resources currently running tasks and counts for each
router.get('/resources/running', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {

    //admin only
    if(!req.user.scopes.amaretti || !~req.user.scopes.amaretti.indexOf("admin")) return next("admin only");
    
    //group by status and count
    db.Task.aggregate([
        {$match: {status: "running"}},
        {$group: {_id: '$resource_id', count: {$sum: 1}}},
    ]).exec(function(err, resources) {
        if(err) return next(err);
        res.json(resources);
    });
});
*/

module.exports = router;

