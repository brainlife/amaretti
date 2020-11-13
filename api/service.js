'use strict';

//contrib
const winston = require('winston');
const async = require('async');
const request = require('request'); //deprecate
const axios = require('axios');

//mine
const config = require('../config');
const db = require('./models');
const common = require('./common');

var _details_cache = {};
exports.loaddetail = function(service_name, branch, cb) {
    var cache = _details_cache[service_name];
    var now = new Date();
    if(cache) {
        //check for expiriation
        var age = new Date() - cache.date;
        if(age > 1000*60*10) { //10 minutes
            //expired
            delete _details_cache[service_name];
        } else {
            //cache is good!
            return cb(null, cache.detail);
        }
    }

    do_loaddetail(service_name, branch, (err, detail)=>{
        //cache the detail
        _details_cache[service_name] = {
            date: new Date(), detail
        };
        cb(null, detail);
    });
}

function check_headers(headers) {
    /* headers:
    { server: 'GitHub.com',
      date: 'Fri, 13 Nov 2020 03:31:51 GMT',
      'content-type': 'application/json; charset=utf-8',
      'content-length': '16700',
      connection: 'close',
      status: '200 OK',
      'cache-control': 'private, max-age=60, s-maxage=60',
      vary:
       'Accept, Authorization, Cookie, X-GitHub-OTP, Accept-Encoding, Accept, X-Requested-With',
      etag:
       '"cf71b2f9d4186c5545ca7e683b4ee83a2b4157ae2e0e34893c740116017482ed"',
      'last-modified': 'Thu, 12 Nov 2020 20:00:45 GMT',
      'x-oauth-scopes': 'repo',
      'x-accepted-oauth-scopes': 'repo',
      'x-github-media-type': 'github.v3',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '3770',
      'x-ratelimit-reset': '1605239555',
      'x-ratelimit-used': '1230',
      'access-control-expose-headers':
       'ETag, Link, Location, Retry-After, X-GitHub-OTP, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Used, X-RateLimit-Reset, X-OAuth-Scopes, X-Accepted-OAuth-Scopes, X-Poll-Interval, X-GitHub-Media-Type, Deprecation, Sunset',
      'access-control-allow-origin': '*',
      'strict-transport-security': 'max-age=31536000; includeSubdomains; preload',
      'x-frame-options': 'deny',
      'x-content-type-options': 'nosniff',
      'x-xss-protection': '1; mode=block',
      'referrer-policy': 'origin-when-cross-origin, strict-origin-when-cross-origin',
      'content-security-policy': 'default-src \'none\'',
      'x-github-request-id': 'A8AE:2171:3432116:813228C:5FADFE27' }
    */

    //report some key stuff
    for(let k in headers) {
        if(k.startsWith('x-ratelimit-')) {
            console.debug(k, headers[k]);
        }
    }
}

function do_loaddetail(service_name, branch, cb) {
    console.log("loading service detail from github");
    if(!branch) branch = "master";
    var detail = {
        name: service_name,
        
        //these script should be in the $PATH on the resource that the app is executed on
        start: "start",
        status: "status",
        stop: "stop",
    }

    async.series([

        //load github repo detail
        next=>{
            console.debug("loading repo detail");
            let url = 'https://api.github.com/repos/'+service_name;
            axios.get(url, {
                headers: {
                    'Authorization': 'token '+config.github.access_token,
                    'User-Agent': 'brainlife/amaretti'
                } 
            //}, function(err, _res, git) {
            }).then(res=>{
                console.log("github api called (repos)", url, res.status);
                check_headers(res.headers);
                if(res.status != 200) {
                    console.error(res.data);
                    return next("failed to query requested repo. "+url+" code:"+res.status);
                }
                detail.git = res.data;
                next(); 
            }).catch(err=>{
                console.error(err);
                cb(err);
            });
        },

        //load package.json (optional)
        next=>{
            //then load package.json (don't need api key?)
            console.debug("loading package.json");
            var url = 'https://raw.githubusercontent.com/'+service_name+'/'+branch+'/package.json';
            axios.get(url, { headers: {
                'User-Agent': 'brainlife/amaretti',
                'Authorization': 'token '+config.github.access_token,
            }}).then(res=>{
                console.log("github api called (package.json)", url, res.status);
                check_headers(res.headers);
                let pkg = res.data;
                //override start/stop/status hooks
                Object.assign(detail, pkg.scripts, pkg.abcd); //pkg.scripts should be deprecated in favor of pkg.abcd
                detail._pkg = pkg; //also store the entire package.json content under detail.. (TODO who uses it?)
                next();
            }).catch(err=>{
                console.debug("no package.json");
                if(err.response && err.response.status == 404) {
                    console.debug("no package.json.. using default hook");
                    return next();
                }
                cb(err);
            });
        },

    ], err=>{
        if(err) return cb(err);

        //all done
        cb(null, detail);
    });
}

var _sha_cache = {};
exports.get_sha = function(service_name, branch, cb) {
    let name = service_name+"@"+branch;
    var cache = _sha_cache[name];
    var now = new Date();
    if(cache) {
        //check for expiriation
        var age = new Date() - cache.date;
        if(age > 1000*10) { //cache for 10 seconds 
            //expired
            delete _sha_cache[name];
        } else {
            //cache is good!
            return cb(null, cache.detail);
        }
    }

    do_load_sha(service_name, branch, (err, detail)=>{
        if(err) return cb(err);
        _sha_cache[name] = {
            date: new Date(), detail
        };
        cb(null, detail);
    });
}

function do_load_sha(service_name, branch, cb) {
    if(!branch) branch = "master";

    //lookup as branch
    let url = 'https://api.github.com/repos/'+service_name+'/git/refs/heads/'+branch;
    axios.get(url, {
        headers: {
            'User-Agent': 'brainlife/amaretti',
            'Authorization': 'token '+config.github.access_token,
        }
    }).then(res=>{
        console.log("github api called (refs/head):", url, res.status);
        check_headers(res.headers);
        cb(null, res.data.object);
    }).catch(err=>{
        //lookup as tags
        let url2 = 'https://api.github.com/repos/'+service_name+'/git/refs/tags/'+branch;
        axios.get(url2, {
            headers: {
                'User-Agent': 'brainlife/amaretti',
                'Authorization': 'token '+config.github.access_token,
            }
        }).then(res=>{
            console.log("github api called (refs/tags):", url2, res.status);
            check_headers(res.headers);
            cb(null, res.data.object);
        }).catch(err=>{
            cb("no such branch/tag:"+branch);
        });
    });
}

