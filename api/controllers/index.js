'use strict';

//contrib
const express = require('express');
const router = express.Router();
const jwt = require('express-jwt');
const winston = require('winston');

//mine
const config = require('../../config');
const logger = new winston.Logger(config.logger.winston);
const db = require('../models/db');
const common = require('../common');

//remote service status (used by /health to analyze)
var _status = {
    task: null,
    resource: null,
};

/**
 * @apiGroup System
 * @api {get} /health Get API status
 * @apiDescription Get current API status
 * @apiName GetHealth
 *
 * @apiSuccess {String} status 'ok' or 'failed'
 */
router.get('/health', function(req, res) {
    //make sure I can query from db
    var ret = {
        status: "ok", //assume to be good
        ssh: common.report_ssh(),
    }

    for(var service in _status) {
        ret[service] = _status[service];
        if(ret[service] == null) {
            ret.status = 'failed';
            ret.message = service+" service not yet reported";
        } else {
            var age = Date.now() - ret[service].update_time;
            ret[service].age = age;
            switch(service) {
            case "task":  
                if(age > 1000*60*10) {
                    ret.status = "warning";
                    ret.message = "task servivce hasn't reported back for more than 10 minutes..";
                }
                if(ret[service].tasks == 0) {
                    ret.status = "warning";
                    ret.message = "no tasks has been processed .. strange";
                }
                if(ret[service].checks < 30) {
                    ret.status = "failed";
                    ret.message = "checks counts is low.. check the check-chain!";
                }
                break;
            case "resource":
                if(age > 1000*60*60*2) {
                    ret.status = "warning";
                    ret.message = "resource servivce hasn't reported back for more than 2 hours..";
                } 
                if(ret[service].resources == 0) {
                    ret.status = "warning";
                    ret.message = "no resource registered?";
                }
                /*
                if(ret[service].oks == 0) {
                    ret.status = "warning";
                    ret.message = "no ok status?";
                }
                */
                break;
            }
        }
    }

    db.Instance.findOne().exec(function(err, record) {
        if(err) {
            ret.status = 'failed';
            ret.message = err;
        }
        if(!record) {
            ret.status = 'failed';
            ret.message = 'no instance from db';
        }
        
        if(ret.status != "ok") logger.debug(ret);

        res.json(ret);
    });
});

//used by task/resource to report cache status
//it should contain hosts counts
router.post('/health/:service', function(req, res) {
    _status[req.params.service] = req.body;
    _status[req.params.service].update_time = Date.now();
    res.send('thanks');
});

router.use('/task',     require('./task'));
router.use('/instance', require('./instance')); 
router.use('/resource', require('./resource'));
router.use('/event', require('./event'));

//TODO DEPRECATED - find out who uses this and get rid of it
//use (get) /resource/type instead
router.get('/config', jwt({secret: config.sca.auth_pubkey, credentialsRequired: false}), function(req, res) {
    var conf = {
        resources: config.resources, //resoruce types
    };
    res.json(conf);
});

module.exports = router;

