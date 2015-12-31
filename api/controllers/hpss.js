'use strict';

//contrib
var express = require('express');
var router = express.Router();
var winston = require('winston');
var jwt = require('express-jwt');
var async = require('async');
var hpss = require('hpss');
var uuid = require('uuid');

//mine
var config = require('../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models/db');
//var scassh = require('../ssh');

router.get('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var path = req.query.path;
    db.Resource.findById(req.query.resource_id, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end();
        if(resource.user_id != req.user.sub) return res.status(401).end();
        var hpss_context = new hpss.context({
            username: resource.config.username,
            auth_method: resource.config.auth_method, //TODO only supports keytab for now
            keytab: new Buffer(resource.config.keytab_base64, 'base64')
        });
        hpss_context.ls(path, function(err, files) {
            if(err) return next({message: "code:"+err.code+" while attemping to ls:"+path});
            res.json(files);
            hpss_context.clean();
        }); 
    });
});

module.exports = router;

