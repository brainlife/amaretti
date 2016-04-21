'use strict';

//contrib
var winston = require('winston');
var async = require('async');

//mine
var config = require('../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('./models/db');

exports.select = function(user_id, query, cb) {

    //select all resource available for the user and online
    db.Resource.find({
        user_id: user_id,
        status: 'ok', 
    })
    .exec(function(err, resources) {
        if(err) return cb(err);

        //select the best resource based on the query
        var best = null;
        var best_score = null;
        resources.forEach(function(resource) {
            var score = score_resource(resource, query);
            //logger.debug(resource._id+" type:"+resource.type+" score="+score);
            if(!best || score > best_score) {
                //normally pick the best score...
                best_score = score;
                best = resource;
            } else if(score == best_score && query.resource_id && query.resource_id == resource._id.toString()) {
                //but if score ties, give user preference into consideration
                logger.debug("using "+query.resource_id+" since score tied");
                best = resource; 
            }
        });

        //for debugging
        logger.debug("best! resource chosen:"+best._id);
        logger.debug(config.resources[best.resource_id]);

        cb(null, best);
    });
}

function score_resource(resource, query) {
    var resource_detail = config.resources[resource.resource_id];
    //logger.debug(resource_detail);
    //see if resource supports the service
    //TODO other things we could do..
    //1... handle query.other_service_ids and give higher score to resource that provides more of those services
    //2... benchmark performance from service test and give higher score on resource that performs better at real time
    //3... take resource utilization into account (pick least used docker host, for example)
    var info = resource_detail.services[query.service_id];
    if(info === undefined) return 0;
    return info.score;
}


