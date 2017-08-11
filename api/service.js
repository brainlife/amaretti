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

var _details_cache = {};
exports.loaddetail_cached = function(service_name, branch, cb) {
    var cache = _details_cache[service_name];
    var now = new Date();
    if(cache) {
        //check for date
        var age = new Date() - cache.date;
        if(age > 1000*60*5) {
            //expired
            delete _details_cache[service_name];
        } else {
            //cache is good!
            //logger.debug("using service cache", service_name);
            return cb(null, cache.detail);
        }
    }
    exports.loaddetail(service_name, branch, cb);
}

exports.loaddetail = function(service_name, branch, cb) {
    if(!branch) branch = "master";
    
    //first load git info
    var repourl = 'https://api.github.com/repos/'+service_name;
    logger.debug("loading repo detail", repourl);
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
        logger.debug('loading https://raw.githubusercontent.com/'+service_name+'/'+branch+'/package.json');
        request('https://raw.githubusercontent.com/'+service_name+'/'+branch+'/package.json', {
            json: true, headers: {'User-Agent': 'IU/SciApt/SCA'}, //required by github
        }, function(err, _res, pkg) {
            if(err) return cb(err);
            var detail = {
                name: service_name,
                git: git,
                pkg: pkg,
            };
            cb(null, detail);

            //store on cache
            _details_cache[service_name] = {
                date: new Date(),
                detail
            };
        });
    });
}


