'use strict';

//contrib
const winston = require('winston');
const async = require('async');
const request = require('request');

//mine
const config = require('../config');
const logger = winston.createLogger(config.logger.winston);
const db = require('./models');
const common = require('./common');

const github_qs = {
    client_id: config.github.client_id,
    client_secret: config.github.client_secret,
}

var _details_cache = {};
exports.loaddetail = function(service_name, branch, cb) {
    var cache = _details_cache[service_name];
    var now = new Date();
    if(cache) {
        //check for date
        var age = new Date() - cache.date;
        if(age > 1000*60*10) { //10 minutes
            //expired
            delete _details_cache[service_name];
        } else {
            //cache is good!
            //logger.debug("using service cache", service_name);
            return cb(null, cache.detail);
        }
    }
    do_loaddetail(service_name, branch, cb);
}

function do_loaddetail(service_name, branch, cb) {
    if(!branch) branch = "master";
    var detail = {
        name: service_name,
        
        //these script should be in the $PATH on the resource that the app is executed on
        start: "start",
        status: "status",
        stop: "stop",
    }

    //logger.debug("loading service details");
    async.series([

        //load github repo detail
        next=>{
            let url = 'https://api.github.com/repos/'+service_name;
            request.get({ url, qs: github_qs, json: true, headers: {'User-Agent': 'brainlife/amaretti'} }, function(err, _res, git) {
                if(err) return next(err);
                if(_res.statusCode != 200) {
                    logger.error(_res.body);
                    return next("failed to query requested repo. "+url+" code:"+_res.statusCode);
                }
                //logger.info(_res.headers);
                detail.git = git;
                next(); 
            });
        },

        /* ref should be loaded at runtime
        next=>{
            let url = 'https://api.github.com/repos/'+service_name+"/git/refs/heads/"+branch;
            request.get({url, qs: github_qs, json: true, headers: {'User-Agent': 'brainlife/amaretti'} }, function(err, _res, body) {
                if(err) return next(err);
                if(_res.statusCode != 200) return next(body);
                detail.ref = body.object;
                next();
            });
        },
        */

        //load package.json (optional)
        next=>{
            //then load package.json (don't need api key?)
            var url = 'https://raw.githubusercontent.com/'+service_name+'/'+branch+'/package.json';
            request.get({url, qs: github_qs, json: true, headers: {'User-Agent': 'brainlife/amaretti'}}, function(err, _res, pkg) {
                if(err) return next(err);
                if(_res.statusCode == 200) {
                    //override start/stop/status hooks
                    Object.assign(detail, pkg.scripts, pkg.abcd); //pkg.scripts should be deprecated in favor of pkg.abcd
                    detail._pkg = pkg; //also store the entire package.json content under detail.. (TODO who uses it?)
                    next();
                } else if(_res.statusCode == 404) {
                    //no package.json.. let's use the default hooks
                    next();
                } else {
                    //github api failed?
                    next(_res.statusCode);
                }
            });
        },

    ], err=>{
        if(err) return cb(err);
        
        //cache the detail
        _details_cache[service_name] = {
            date: new Date(),
            detail
        };
        //console.log(JSON.stringify(detail, null, 4));

        //all done
        cb(null, detail);
    });
}

exports.get_sha = function(service_name, branch, cb) {
    if(!branch) branch = "master";
    //let url = 'https://api.github.com/repos/'+service_name+"/git/refs/heads/"+branch;
    let url = 'https://api.github.com/repos/'+service_name+"/git/refs";
    logger.debug(url);
    request.get({url, qs: github_qs, json: true, headers: {'User-Agent': 'brainlife/amaretti'} }, (err, _res, body)=>{
        if(err) return cb(err);
        if(_res.statusCode != 200) {
            logger.error(body);
            logger.debug(url);
            return cb(body);
        }
        let refs = body;
        let ref = refs.find(ref=>ref.ref.endsWith("/"+branch));
        if(!ref) return cb("no such branch/tag:"+branch);
        logger.debug(ref.object);
        cb(null, ref.object);
    });
}

