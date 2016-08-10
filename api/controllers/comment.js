'use strict';

//contrib
var express = require('express');
var router = express.Router();
var winston = require('winston');
var jwt = require('express-jwt');
var async = require('async');
var fs = require('fs');

//mine
var config = require('../../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models/db');

//get comments
router.get('/:type/:subid', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    db.Comment.find({
        type: req.params.type,
        subid: req.params.subid,
    })
    .sort('create_date')
    .exec(function(err, comments) {
        if(err) return next(err);
        res.json(comments);
    });
});

//post new comment
router.post('/:type/:subid', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var comment = new db.Comment({
        type: req.params.type, 
        subid: req.params.subid, 
        user_id: req.user.sub, 
        _profile: req.user.profile,
        text: req.body.text
    }); 
    comment.save(function(err) {
        if(err) return next(err);
        res.json(comment);
    });
});

module.exports = router;
