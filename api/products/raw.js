'use strict';

//contrib
var express = require('express');
var router = express.Router();
var winston = require('winston');
var jwt = require('express-jwt');
//var async = require('async');
var Client = require('ssh2').Client;

//mine
var config = require('../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models/db');
//var common = require('../common');

//stream file content via ssh using cat.. I wish there is a way to directly download the file from the compute element
function stream_remote_file(resource, dirname, file, res, cb) {
    var path = dirname+"/"+file.filename;

    var conn = new Client();
    conn.on('ready', function() {
        //get filesize first (TODO - do this only if file.size isn't set)
        conn.exec("stat --printf=%s "+path, function(err, stream) {
            if(err) return cb(err);
            var size = "";
            stream.on('data', function(data) {
                size += data;
            });
            stream.on('close', function() {
                res.setHeader('Content-Length', size);
                res.setHeader('Content-disposition', 'attachment; filename='+file.filename);
                if(file.type) res.setHeader('Content-type', file.type); 

                //then stream
                var escaped_path = path.replace(/"/g, '\\"');
                conn.exec("cat \""+escaped_path+"\"", function(err, stream) {
                    if(err) return cb(err);
                    stream.on('data', function(data) {
                        res.write(data);
                    });
                    stream.on('end', function() {
                        res.end();
                    });
                    stream.on('close', function() {
                        conn.end();
                        cb();
                    })
                });
            });
        });
    });
    var detail = config.resources[resource.resource_id];
    conn.connect({
        host: detail.hostname,
        username: resource.config.username,
        privateKey: resource.config.ssh_private,
    });
}

//TODO - since I can't let <a> pass jwt token via header, I have to expose it via URL.
//doing so increases the chance of user misusing the token, but unless I use HTML5 File API
//there isn't a good way to let user download files..
//getToken() below allows me to check jwt token via "at" query.
router.get('/', jwt({
    secret: config.sca.auth_pubkey,
    getToken: function fromHeaderOrQuerystring (req) { return req.query.at; }
}), function(req, res, next) {
    //var task_id = req.query.t;
    var product_id = req.query.p;
    var file_id = req.query.f;
    db.Product.findById(product_id, function(err, product) {
        if(err) return next(err);
        if(!product) return res.status(404).end();
        if(product.user_id != req.user.sub) return res.status(401).end();
        if(product.detail.type != "raw") return next("product type is not raw");
        db.Resource.findById(product.resources.compute, function(err, resource) {
            if(err) return next(err);
            if(!resource) return res.status(404).end();
            if(resource.user_id != req.user.sub) return res.status(401).end(); //shouldn't be needed, but just in case..
            //var taskdir = common.gettaskdir(product.workflow_id, product.task_id, resource);
            var file = product.detail.files[file_id];
            stream_remote_file(resource, product.path, file, res, function(err) {
                if(err) return next(err);
            });
        });
    });
    /*
    db.Resource.findById(req.query.resource_id, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end();
        if(resource.user_id != req.user.sub) return res.status(401).end();
        var hpss_context = new hpss.context({
            username: resource.config.username,
            auth_method: resource.config.auth_method, //TODO only supports keytab for now
            keytab: new Buffer(resource.config.keytab_base64, 'base64')
        });
        hpss_context.ls(path, function(err, files) {
            if(err) return next({message: "code:"+err.code+" while attemping to ls:"+path});
            res.json(files);
            hpss_context.clean();
        }); 
    });
    */
});

module.exports = router;

