'use strict';

//contrib
var express = require('express');
var router = express.Router();
var winston = require('winston');
var jwt = require('express-jwt');
var async = require('async');
var fs = require('fs');
var ejs = require('ejs');
var _ = require('underscore');

//mine
var config = require('../../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models/db');

//get all workflows registered (add query capability to limit number of workflow returned)
router.get('/', function(req, res, next) {
    res.json(config.workflows);
    
    /*
    //now load the workflow instances
    //TODO - I am not sure if pulling workflow instance here is a good idea.. maybe I should let /instance take care of this?
    db.Instance
    .find({user_id: req.user.sub})
    .sort({'update_date':1})
    .exec(function(err, insts) {
        if(err) return next(err);
        insts.forEach(function(inst) {
            var w = workflows[inst.workflow_id];
            if(!w) logger.error("couldn't find inst.workflow_id:"+inst.workflow_id);
            else workflows[inst.workflow_id].insts[inst._id] = inst;
        });
        res.json(workflows);
    });
    */
});

router.get('/:workflowid', function(req, res, next) {
    res.json(config.workflows[req.params.workflowid]);
});

module.exports = router;

