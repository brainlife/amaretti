'use strict';

//contrib
var winston = require('winston');
var request = require('request');

//mine
var config = require('./config');
var logger = new winston.Logger(config.logger.winston);

exports.update = function(key, p, cb) {
    request({
        url: config.progress.api+'/update', 
        headers: {
            'Authorization': 'Bearer '+config.progress.jwt,
        }, 
        form: {key: key, p: p},
    }, function(err, res, body){
        if(cb) cb(err, body);
    });
}

