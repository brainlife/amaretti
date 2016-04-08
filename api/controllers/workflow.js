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

//get all workflows registered (and instances that user has created for each workflows)
router.get('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var workflows = _.clone(config.workflows);
    for(var id in workflows) {
        workflows[id].insts = {};
    }
    //now load the workflow instances
    db.Workflow
    .find({user_id: req.user.sub})
    .sort({'update_date':1})
    /*
    .select({
        name: 1,
        desc: 1,
        create_date: 1,
        update_date: 1
    })
    */
    //.populate('steps.tasks')
    .exec(function(err, insts) {
        if(err) return next(err);
        insts.forEach(function(inst) {
            var w = workflows[inst.type_id];
            if(!w) logger.error("couldn't find inst.type_id:"+inst.type_id);
            else workflows[inst.type_id].insts[inst._id] = inst;
        });
        res.json(workflows);
    });
});

module.exports = router;

