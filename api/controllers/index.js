'use strict';

const express = require('express');
const router = express.Router();
const jwt = require('express-jwt');
const winston = require('winston');
const request = require('request');
const redis = require('redis');

//mine
const config = require('../../config');
const logger = new winston.Logger(config.logger.winston);
const db = require('../models');
const common = require('../common');
const transfer = require('../transfer'); //for health
const health = require('../health');

/**
 * @apiGroup System
 * @api {get} /health Get API status
 * @apiDescription Get current API status
 * @apiName GetHealth
 *
 * @apiSuccess {String} status 'ok' or 'failed'
 */
router.get('/health', function(req, res, next) {
    //logger.debug("healgh api");    
    health.get_reports((err, reports)=>{
        if(err) return next(err);
        var status = "ok";
        var messages = [];
        //aggregate reports from all services
        for(var service in reports) {
            var report = reports[service];
            if(report.status != "ok") {
                status = "failed";
                messages.push(service+" is failing");
            }
            
            //check report date
            var age = Date.now() - new Date(report.date).getTime();
            messages.push(service+" age "+age+" msec");
            if(age > (report.maxage||1000*60)) {
                status = "failed";
                messages.push(service+" is stale max:"+report.maxage);
            }
        }  
        if(status != "ok") logger.error(JSON.stringify({messages, reports}, null, 4));
        res.json({status, messages, reports});
    });
});

router.use('/task',     require('./task'));
router.use('/instance', require('./instance')); 
router.use('/resource', require('./resource'));
router.use('/event', require('./event'));

//TODO DEPRECATED (currently used by th /wf/#!/resources UI)
//use (get) /resource/type instead
router.get('/config', jwt({secret: config.sca.auth_pubkey, credentialsRequired: false}), function(req, res) {
    var conf = {
        resources: config.resources, //resoruce types
    };
    res.json(conf);
});

module.exports = router;

