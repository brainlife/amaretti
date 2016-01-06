'use strict';

//contrib
var express = require('express');
var router = express.Router();
var winston = require('winston');
var jwt = require('express-jwt');
var async = require('async');
var hpss = require('hpss');

//mine
var config = require('../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models/db');

router.get('/bytaskid/:id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    db.Product.find({task_id: req.params.id}, function(err, products) {
        if(err) return next(err);
        //only return products that belongs to the user
        var _products = [];
        products.forEach(function(product) {
            if(product.user_id == req.user.sub) _products.push(product);
        });
        res.json(_products);
    });
});

module.exports = router;

