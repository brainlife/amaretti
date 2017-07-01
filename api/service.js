'use strict';

//contrib
var winston = require('winston');
var async = require('async');
var request = require('request');

//mine
var config = require('../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('./models');
var common = require('./common');

exports.loaddetail = function(service_name, cb) {
    //first load git info
    var repourl = 'https://api.github.com/repos/'+service_name;
    if(config.github) {
        repourl += "?client_id="+config.github.client_id;
        repourl += "&client_secret="+config.github.client_secret;
    }
    request(repourl, { json: true, headers: {'User-Agent': 'IU/SciApt/SCA'} }, function(err, _res, git) {
        if(err) return cb(err);
        if(_res.statusCode != 200) {
            logger.error(repourl);//could contain github key... but
            logger.error(_res.body);
            return cb("failed to query requested repo. code:"+_res.statusCode);
        }

        //then load package.json
        //TODO - should I always use master - or let user decide?
        logger.debug('https://raw.githubusercontent.com/'+service_name+'/master/package.json');
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


