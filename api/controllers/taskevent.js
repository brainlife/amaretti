'use strict';

const express = require('express');
const router = express.Router();
const async = require('async');
const mongoose = require('mongoose');
const path = require('path');
const mime = require('mime');
const multer = require('multer');
const fs = require('fs');

const config = require('../config');
const db = require('../models');
const events = require('../events');
const common = require('../common');

/**
 * @apiGroup Taskevent
 * @api {get} /taskevent/:taskid 
                                Query Task events
 * @apiDescription              Returns all task status update events for a given task id
 *
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object}         List of taskevents
 */
router.get('/:taskId', common.jwt(), function(req, res, next) {
    let find = {task_id: req.params.taskId};

    //access control
    if(!req.user.scopes.amaretti || !~req.user.scopes.amaretti.indexOf("admin")) {
        find['$or'] = [
            {user_id: req.user.sub},
            {_group_id: {$in: req.user.gids||[]}},
        ];
    }

    //if(req.query.select) console.log("select:"+req.query.select);
    db.Taskevent.find(find)
    .lean()
    .sort('date')
    .exec(function(err, taskevents) {
        if(err) return next(err);
        res.json({taskevents});
    });
});

module.exports = router;

