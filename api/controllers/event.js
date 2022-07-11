'use strict';

//contrib
const express = require('express');
const router = express.Router();

//mine
const config = require('../config');
const common = require('../common');
const db = require('../models');

router.get('/checkaccess/instance/:id', common.jwt(), function(req, res, next) {

    //allow admin to access any instances (for admin task view)
    if(req.user.scopes.amaretti && ~req.user.scopes.amaretti.indexOf("admin")) {
        res.json({status: "ok", admin: true});
        return;
    }

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
