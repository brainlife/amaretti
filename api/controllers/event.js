'use strict';

//contrib
const express = require('express');
const router = express.Router();
const winston = require('winston');
const jwt = require('express-jwt');

//mine
const config = require('../../config');
const logger = winston.createLogger(config.logger.winston);
const db = require('../models');

router.get('/checkaccess/instance/:id', jwt({secret: config.amaretti.auth_pubkey}), function(req, res, next) {
    let instid = req.params.id;
    db.Instance.findOne({
        _id: instid, 
        '$or': [
            {user_id: req.user.sub},
            {group_id: {$in: req.user.gids||[]}},
        ]
    }, function(err, instance) {
        if(err) return next(err);
        if(!instance) res.status(401).end("no such instance or you don't have access to it");
        res.json({status: "ok"});
    });
});

module.exports = router;
