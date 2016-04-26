'use strict';

//contrib
var express = require('express');
var router = express.Router();
var winston = require('winston');
var jwt = require('express-jwt');
var async = require('async');
var fs = require('fs');
var ejs = require('ejs');

//mine
var config = require('../../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models/db');

//get all services registered 
//TODO add query capability and limit number of services returned by default
router.get('/', function(req, res, next) {
    res.json(config.services);
});

/*
router.get('/:workflowid', function(req, res, next) {
    res.json(config.workflows[req.params.workflowid]);
});
*/

module.exports = router;

