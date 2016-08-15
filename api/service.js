'use strict';

//contrib
var winston = require('winston');
var async = require('async');
var request = require('request');

//mine
var config = require('../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('./models/db');
var common = require('./common');

exports.loaddetail = function(service_name, cb) {
    //first load git info
    request('https://api.github.com/repos/'+service_name, {
        json: true, headers: {'User-Agent': 'IU/SciApt/SCA'}, //required by github
    }, function(err, _res, git) {
        if(err) return cb(err);
        if(_res.statusCode != 200) return cb("failed to query requested repo. code:"+_res.statusCode);

        //then load package.json
        //TODO - should I always use master - or let user decide?
        request('https://raw.githubusercontent.com/'+service_name+'/master/package.json', {
            json: true, headers: {'User-Agent': 'IU/SciApt/SCA'}, //required by github
        }, function(err, _res, pkg) {
            if(err) return cb(err);
            cb(null, {
                //user_id: req.user.sub,
                //giturl: giturl,
                name: service_name,
                git: git,
                pkg: pkg,
            });
        });
    });
}


