'use strict';

//contrib
var express = require('express');
var router = express.Router();
var jwt = require('express-jwt');
var _ = require('underscore');

//mine
var config = require('../config');

router.get('/health', function(req, res) {
    res.json({status: 'ok'});
});

router.get('/config', jwt({secret: config.sca.auth_pubkey, credentialsRequired: false}), function(req, res) {
    var conf = {
        /*
        service_types: config.meshconfig.service_types,
        mesh_types: config.meshconfig.mesh_types,
        defaults: config.meshconfig.defaults,
        //menu: get_menu(req.user),
        */
        hello: 'todo',
    };
    res.json(conf);
});

/*
router.use('/configs', require('./controllers/configs'));
router.use('/testspecs', require('./controllers/testspecs'));
router.use('/cache', require('./controllers/cache'));
router.use('/hostgroups', require('./controllers/hostgroups'));
*/

module.exports = router;

