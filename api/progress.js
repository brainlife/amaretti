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
        rejectUnauthorized: false, //this maybe needed if the https server doesn't contain intermediate cert ..
        json: p, 
    }, function(err, res, body){
        if(err) {
            logger.debug(err);
        } else {
            //logger.debug("successfully posted progress update:"+key);
            logger.debug([key, p]);
        }
        if(cb) cb(err, body);
    });
}

