'use strict';

//node
var fs = require('fs');

//contrib
var express = require('express');
var router = express.Router();
var winston = require('winston');
var jwt = require('express-jwt');
var async = require('async');
var uuid = require('uuid');
var multiparty = require('multiparty');
var Client = require('ssh2').Client;

//mine
var config = require('../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models/db');
var common = require('../common');

router.post('/files', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var workflow_id = req.query.w;
    var step_id = req.query.s;
    var resource_id = req.query.resource_id;
    db.Resource.findById(resource_id, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end();
        if(resource.user_id != req.user.sub) return res.status(401).end();
        var resource_detail = config.resources[resource.resource_id];

        //create product record to store results
        db.Workflow.findById(workflow_id, function(err, workflow) {
            if(err) return next(err);
            if(!workflow) return res.status(404).end();
            if(workflow.user_id != req.user.sub) return res.status(401).end();
            var product = new db.Product({
                workflow_id: workflow_id,
                user_id: req.user.sub,
                service_id: 'upload', //TODO can I get it from the config?
                name: 'whaterver', //TODO.. what is this used for?
                resources: {compute: resource_id},
            });
            product.path = common.gettaskdir(workflow_id, "upload."+product._id, resource);
            product.detail = {type: "raw", files: []}; //TODO - let user decide the data type

            //now setup stream
            var conn = new Client();
            conn.on('ready', function() {
                //now start parsing
                var form = new multiparty.Form();
                form.on('error', function(err) {
                    //TODO
                    console.error("error while parsing form-data");
                });
                form.on('part', function(part) {
                    //stream to remote file system
                    conn.exec("mkdir -p "+product.path+" && cat /dev/stdin > "+product.path+"/"+part.filename, {}, function(err, stream) {
                        if(err) next(err);
                        product.detail.files.push({filename: part.filename, size: part.byteCount, type: part.headers['content-type']});
                        part.pipe(stream);
                    });
                    /*
                    part.on('end', function() {
                        //part.resume();
                        //console.log("part ended");
                    });
                    */
                });
                form.on('close', function() {
                    //console.log("all done");
                    conn.end();
                    product.save(function(err) {
                        if(err) return next(err);
                        workflow.steps[step_id].products.push(product._id);
                        workflow.save(function(err) {
                            if(err) return next(err);
                            res.json(product);
                        });
                    })
                });
                form.parse(req);
            });
            conn.connect({
                host: resource_detail.hostname,
                username: resource.config.username,
                privateKey: resource.config.ssh_private,
            });

        });
    });
});

module.exports = router;

