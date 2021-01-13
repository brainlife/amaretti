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
const logger = winston.createLogger(config.logger.winston);
const db = require('../models');
const common = require('../common');

/**
 * @apiGroup Task
 * @api {get} /service/info     Query service info
 * @apiDescription              Returns service info
 *
 * @apiParam {String} service   Service Name
 * 
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object}         List of tasks (maybe limited / skipped) and total number of tasks
 */
//TODO - who else uses this other than appinfo now? Can we make this admin only?
router.get('/info', jwt({secret: config.amaretti.auth_pubkey/*, credentialsRequired: false*/}), function(req, res, next) {
    let find = {service: req.query.service};

    //TODO - should I hide info for private service if user is not member of the project?
    db.Serviceinfo.findOne(find)
    .exec(function(err, info) {
        if(err) return next(err);
        res.json(info);
    });
});

/*
//(experimental) 
//return a list of currently running tasks for each task
//ussed by appinfo
router.get('/tasks', jwt({secret: config.amaretti.auth_pubkey}), async (req, res, next)=>{
    let tasks = await db.Task.find({
        service: req.query.service,
        status: {$in: ["requested", "running", "running_sync"]},
    }).lean().select('_id user_id _group_id service service_branch status status_msg create_date start_date').exec()
    res.json(tasks);
});
*/

module.exports = router;

