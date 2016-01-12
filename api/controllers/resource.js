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
var common = require('../common');


function mask_enc(resource) {
    //mask all config parameters that starts with enc_
    for(var k in resource.config) {
        if(k.indexOf("enc_") === 0) {
            resource.config[k] = true;
        }
    }
}
//return all resource detail that belongs to the user
router.get('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    db.Resource.find({
        user_id: req.user.sub
    })
    .exec(function(err, resources) {
        if(err) return next(err);
        resources.forEach(mask_enc);
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

//update
router.put('/:id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.id;
    /*
    db.Resource.findOneAndUpdate({_id: id, user_id: req.user.sub}, {$set: resource}, {new: true}, function(err, resource) {
        if(err) return next(err);
        res.json(resource);
    });
    */
    db.Resource.findOne({_id: id}, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end();
        if(resource.user_id != req.user.sub) return res.status(401).end();

        //need to decrypt first so that I can copy previous values if needed
        common.decrypt_resource(resource);
        console.dir(req.body);

        //keep old value if enc_ fields are set to true
        for(var k in req.body.config) {
            if(k.indexOf("enc_") === 0) {
                var v = req.body.config[k];
                if(v === true) {
                    req.body.config[k] = resource.config[k];
                }
            }
        }
        common.encrypt_resource(req.body);
        db.Resource.update({_id: id}, { $set: req.body }, {new: true}, function(err) {
            if(err) return next(err);
            mask_enc(req.body);
            res.json(req.body);
        });
    });
});

//new
router.post('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var resource = new db.Resource(req.body);
    common.encrypt_resource(resource);
    resource.user_id = req.user.sub;
    resource.save(function(err) {
        if(err) return next(err);
        mask_enc(resource);
        res.json(resource);
    });
});

module.exports = router;

