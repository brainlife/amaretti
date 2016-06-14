'use strict';

//contrib
var express = require('express');
var router = express.Router();
var jwt = require('express-jwt');

//mine
var config = require('../../config');

/**
 * @api {get} /health Get API status
 * @apiDescription Get current API status
 * @apiName GetHealth
 * @apiGroup System
 *
 * @apiSuccess {String} status 'ok' or 'failed'
 */
router.get('/health', function(req, res) {
    res.json({status: 'ok'});
});

router.get('/config', jwt({secret: config.sca.auth_pubkey, credentialsRequired: false}), function(req, res) {
    var conf = {
        resources: config.resources, //resoruce bases..
        //services: config.services,
    };
    res.json(conf);
});

router.use('/workflow', require('./workflow'));
router.use('/instance', require('./instance')); //workflow instances
router.use('/resource', require('./resource'));
router.use('/task', require('./task'));
router.use('/service', require('./service'));
router.use('/comment', require('./comment'));

module.exports = router;

