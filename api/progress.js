'use strict';

//contrib
var winston = require('winston');
var request = require('request');

//mine
var config = require('./config');
var logger = new winston.Logger(config.logger.winston);

exports.update = function(key, p, cb) {
    request({
        method: 'POST',
        url: config.progress.api+'/status/'+key, 
        /*
        headers: {
            'Authorization': 'Bearer '+config.progress.jwt,
        }, 
        */
        json: p, 
    }, function(err, res, body){
        logger.debug("posted progress update:"+key);
        logger.debug(p);
        if(cb) cb(err, body);
    });
}

