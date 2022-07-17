'use strict';

//contrib
const express = require('express');
const router = express.Router();
const async = require('async');
const mongoose = require('mongoose');
const path = require('path');
const mime = require('mime');

//mine
const config = require('../../config');
const db = require('../models');
const common = require('../common');

//return list of services currently running and counts for each
/**
 * @apiGroup                    Admin
 * @api {get} /services/running 
 *                              Running/requested task count
 * @apiDescription              Returns list of counts of running/requested tasks grouped by service/resource/user 
 * @apiHeader {String}          Authorization A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object}         List of count groups
 */
router.get('/services/running', common.jwt(), function(req, res, next) {
    if(!req.user.scopes.amaretti || !~req.user.scopes.amaretti.indexOf("admin")) return next("admin only");

    db.Task.aggregate([
        {$match: {
            $or: [
                {status: "running"},

                //also include requests that are currently getting started - so that we don't undercount tasks
                //while deciding how many are commited to run on various resources
                {status: "requested", start_date: {$exists: true}}, 
            ]
        }},
        {$group: {_id: {service: '$service', resource_id: '$resource_id', user_id: '$user_id'}, count: {$sum: 1}}},
    ]).exec(function(err, services) {
        if(err) return next(err);
        res.json(services);
    });
});

module.exports = router;

