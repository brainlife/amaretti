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
var config = require('../config');
var logger = new winston.Logger(config.logger.winston);
//var common = require('../common');
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

/*
//construct html frame needed for the workflow
var html_template = ejs.compile(fs.readFileSync(__dirname+"/workflow.html", {encoding: 'utf8'}));
router.get('/html/:instid', function(req, res, next) {
    //get specified workflow instance
    var instid = req.params.instid;
    db.Workflow.findById(instid)
    //.populate('steps.tasks')
    //.populate('steps.products')
    .exec(function(err, workflow_inst) {
        if(err) return next(err);
        if(!workflow_inst) return next("can't find specified workflow instance"); 

        //get workflow detail
        common.getWorkflows(function(err, workflows) {
            if(err) return next(err);
            var workflow = workflows[workflow_inst.type_id];

            //TODO - maybe I should only load services / products referenced by this workflow
            //for now, let's just load all registered services / products
            common.getProducts(function(err, products) {
                if(err) return next(err);
                console.dir(products);
                common.getServices(function(err, services) {
                    if(err) return next(err);
                    res.end(html_template({
                        products: products, 
                        services: services, 
                        workflow: workflow,
                        inst: workflow_inst,
                    }));
                });
            });
        });
    }); 
});
*/
/*
//get all workflows instances for this user
router.get('/insts', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    db.Workflow
    .find({
        user_id: req.user.sub
    })
    .sort({'update_date':1})
    .select({
        name: 1,
        desc: 1,
        create_date: 1,
        update_date: 1
    })
    .populate('steps.tasks')
    .exec(function(err, workflows) {
        if(err) return next(err);
        res.json(workflows);
    });
});
*/

module.exports = router;

