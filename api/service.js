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
    if(!config.github) return cb("no github config");
    if(!branch) branch = "master";
    
    //first load git info
    var repourl = 'https://api.github.com/repos/'+service_name;
    logger.debug("loading repo detail", repourl);
    repourl += "?client_id="+config.github.client_id;
    repourl += "&client_secret="+config.github.client_secret;
    request(repourl, { json: true, headers: {'User-Agent': 'brain-life/amaretti'} }, function(err, _res, git) {
        if(err) return cb(err);
        if(_res.statusCode != 200) {
            logger.error(repourl);//could contain github key... but
            logger.error(_res.body);
            return cb("failed to query requested repo. code:"+_res.statusCode);
        }

        //then load package.json
        var pac_url = 'https://raw.githubusercontent.com/'+service_name+'/'+branch+'/package.json';
        logger.debug('loading '+pac_url);
        request(pac_url, {
            json: true, headers: {'User-Agent': 'IU/SciApt/SCA'}, //required by github
        }, function(err, _res, pkg) {
            if(err) return cb(err);

            //default detail
            var detail = {
                name: service_name,
                git,

                //these script should be in the $PATH on the resource that the app is executed on
                start: "start",
                status: "status",
                stop: "stop",
            }

            if(_res.statusCode == 200) {
                //override
                Object.assign(detail, pkg.scripts, pkg.abcd); //pkg.scripts should be deprecated in favor of pkg.abcd
                detail._pkg = pkg; //also store the entire package.json content under detail..
            } else {
                logger.info("couldn't load package.json - using default");
            }

            //cache the detail
            _details_cache[service_name] = {
                date: new Date(),
                detail
            };

            cb(null, detail);
        });
    });
}


