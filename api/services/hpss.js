'use strict';

//contrib
var express = require('express');
var router = express.Router();
var winston = require('winston');
var jwt = require('express-jwt');
var async = require('async');
var hpss = require('hpss');
//var uuid = require('uuid');

//mine
var config = require('../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models/db');
var common = require('../common');
//var scassh = require('../ssh');

router.get('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var path = req.query.path;
    var limit = parseInt(req.query.limit||64);
    var offset = parseInt(req.query.offset||0);
    db.Resource.findById(req.query.resource_id, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end();
        if(resource.user_id != req.user.sub) return res.status(401).end();
        common.decrypt_resource(resource);
        var hpss_context = new hpss.context({
            username: resource.config.username,
            auth_method: resource.config.auth_method, //TODO only supports keytab for now
            keytab: new Buffer(resource.config.enc_keytab, 'base64')
        });
        hpss_context.ls(path, {limit: limit, offset: offset}, function(err, files) {
            if(err) return next({message: "code:"+err.code+" while attemping to ls:"+path});
            //console.log("got "+files.length);
            //console.log(JSON.stringify(files, null, 4));
            res.json(files);
            hpss_context.clean();
        }); 
    });
});

module.exports = router;

