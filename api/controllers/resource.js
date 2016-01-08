'use strict';

//contrib
var express = require('express');
var router = express.Router();
var winston = require('winston');
var jwt = require('express-jwt');
var async = require('async');

//mine
var config = require('../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models/db');

//return all resource detail that belongs to the user
router.get('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    db.Resource.find({
        user_id: req.user.sub
    })
    .exec(function(err, resources) {
        if(err) return next(err);
        //TODO - I should not return private keys directly to the user. I should return true/false instead, and only allow update with new content
        res.json(resources);
    });
});

/*
//TODO nobody uses this yet
router.get('/:resource_id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    db.Resource.findOne({
        resource_id: req.params.resource_id,
        user_id: req.user.sub,
    })
    .exec(function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end();
        res.json(resource);
    });
});
*/
router.put('/:id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.id;
    var resource = req.body;
    db.Resource.update({_id: id, user_id: req.user.sub}, {$set: resource}, function(err, resource) {
        if(err) return next(err);
        res.json(resource);
    });
});

router.post('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var resource = new db.Resource(req.body);
    resource.user_id = req.user.sub;
    resource.save(function(err) {
        if(err) return next(err);
        res.json(resource);
    });
});

module.exports = router;

