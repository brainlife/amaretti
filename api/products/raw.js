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
var common = require('../common');

//stream file content via ssh using cat.. I wish there is a way to directly download the file from the compute element
function stream_remote_file(resource, dirname, file, res, cb) {
    var path = dirname+"/"+file.filename;

    var conn = new Client();
    conn.on('ready', function() {
        /*
        //get filesize first (TODO - do this only if file.size isn't set)
        conn.exec("stat --printf=%s "+path, function(err, stream) {
            if(err) return cb(err);
            var size = "";
            stream.on('data', function(data) {
                size += data;
            });
            stream.on('close', function() {
            });
        });
        */

        res.setHeader('Content-disposition', 'attachment; filename='+file.filename);
        if(file.size) res.setHeader('Content-Length', file.size);
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
    var detail = config.resources[resource.resource_id];
    //common.
    conn.connect({
        host: detail.hostname,
        username: resource.config.username,
        privateKey: resource.config.enc_ssh_private,
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
    var task_id = req.query.t;
    var product_id = req.query.p;
    var file_id = req.query.f;
    db.Task.findById(task_id, function(err, task) {
        if(err) return next(err);
        if(!task) return res.status(404).json({message: "couldn't find the task specified:"+task_id});
        if(task.user_id != req.user.sub) return res.status(401).end();
        var product = task.products[product_id];
        if(product.type != "raw") return next("product type is not raw");
        db.Resource.findById(task.resources.compute, function(err, resource) {
            if(err) return next(err);
            if(!resource) return res.status(404).json({message: "couldn't find the resource used to run this task"+task.resources.compute});
            if(resource.user_id != req.user.sub) return res.status(401).end(); //shouldn't be needed, but just in case..
            common.decrypt_resource(resource);
            var file = product.files[file_id];
            var path = common.gettaskdir(task.workflow_id, task_id, resource);
            stream_remote_file(resource, path, file, res, function(err) {
                if(err) return next(err);
            });
        });
    });
});

module.exports = router;

