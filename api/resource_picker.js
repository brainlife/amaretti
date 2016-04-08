'use strict';

//contrib
var winston = require('winston');
var async = require('async');

//mine
var config = require('../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('./models/db');

exports.select = function(user_id, score_func, cb) {

    //select all resource available for the user
    db.Resource.find({
        user_id: user_id
    })
    .exec(function(err, resources) {
        if(err) return cb(err);

        //select the best resource based on the query
        var best = null;
        var best_score = null;
        resources.forEach(function(resource) {
            var score = score_func(resource);
            logger.debug(resource._id+" type:"+resource.type+" score="+score);
            if(!best || score > best_score) {
                best_score = score;
                best = resource;
            }
        });

        //for debugging
        logger.debug("best! resource chosen:"+best._id);
        logger.debug(config.resources[best.resource_id]);

        cb(null, best);
    });
}
