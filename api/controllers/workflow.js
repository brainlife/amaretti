'use strict';

//contrib
var express = require('express');
var router = express.Router();
var winston = require('winston');
var jwt = require('express-jwt');
var async = require('async');
var fs = require('fs');

//mine
var config = require('../../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models/db');

//TODO store this in DB, and add query capability
router.get('/', function(req, res, next) {
    res.json({workflows: config.workflows, count: config.workflows.length});
});

//TODO redundant..
router.get('/:workflowid', function(req, res, next) {
    res.json(config.workflows[req.params.workflowid]);
});

module.exports = router;

