'use strict';

//contrib
const express = require('express');
const router = express.Router();
const jwt = require('express-jwt');

//mine
const config = require('../../config');
const db = require('../models/db');
//const common = require('../common');

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

        //I am not sure if I should publish this or not...
        //ssh: common.ssh_connection_counts(),
    }

    db.Instance.find({name: 'nobother'}).exec(function(err, record) {
        if(err) {
            ret.status = 'failed';
            ret.message = err;
            res.json(ret);
        } else {
            res.json(ret);
        }
    });
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

