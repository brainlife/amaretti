'use strict';

//node
var fs = require('fs');

//contrib
var express = require('express');
var bodyParser = require('body-parser');
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

router.post('/files', 
    //doesn't seem to make any difference.. the nginx does limit file size, btw
    //bodyParser.json({limit: '50gb'}), 
    //bodyParser.urlencoded({limit: '50gb', extended: true}), 
    jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {

    var workflow_id = req.query.w;
    var step_id = req.query.s;
    var resource_id = req.query.resource_id;
    
    //load & check resource
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
            var task = new db.Task({
                workflow_id: workflow_id,
                step_id: step_id,
                user_id: req.user.sub,
                service_id: 'upload', 
                //progress_key
                resources: {compute: resource_id},
                //config: {}, 
            });
            var product = {type: "raw", files: []};
            var path = common.gettaskdir(workflow_id, task._id, resource);

            //open ssh connection to remote compute resource
            var conn = new Client();
            conn.on('ready', function() {
                //now stream
                stream_form(req, conn, path, task, product, function(err) {
                    if(err) next(err);

                    //lastly, write out products.json (just in case..)
                    conn.exec("cat > "+path+"/products.json", function(err, stream) {
                        if(err) next(err);
                        stream.on('close', function() {
                            
                            //now I can close ssh
                            conn.end();

                            //store product info on the task document.
                            task.products = [product];
                            task.status = 'finished';
                            task.save(function(err) {
                                workflow.steps[step_id].tasks.push(task._id);
                                workflow.save(function(err) {
                                    if(err) return next(err);
                                    res.json(task);
                                });
                            });
                        })
                        stream.write(JSON.stringify([product], null, 4));
                        stream.end();
                    });
                });
            });
            conn.connect({
                host: resource_detail.hostname,
                username: resource.config.username,
                privateKey: resource.config.ssh_private,
            });
        });
    });
});

//TODO ugly sig..
function stream_form(req, conn, path, task, product, cb) {
    //now start parsing
    var open_streams = 0;
    var form = new multiparty.Form({autoFields: true});
    form.on('error', cb);
    form.on('close', alldone);

    function alldone() {
        if(open_streams == 0) {
            //logger.info("all done");
            cb();
        } else {
            //I need to wait for all stream to close before moving on..
            logger.info("waiting for streams to close (remaining:"+open_streams+")");
            setTimeout(alldone, 1000);
        }
    };
    form.on('field', function(name, value) {
        //TODO validate?
        switch(name) {
        case "task[name]": task.name = value; break;
        case "task[type]": product.type = value; break;
        default: 
            logger.error("unknown field name:"+name);
        }
    });
    form.on('part', function(part) {
        //logger.debug("received part "+part.filename);
        //logger.debug("expected size:"+part.byteCount);
        //stream file to remote system
        var escaped_filename = part.filename.replace(/"/g, '\\"');
        conn.exec("mkdir -p "+path+" && cat /dev/stdin > \""+path+"/"+escaped_filename+"\"", {}, function(err, stream) {
            if(err) cb(err);
            open_streams++;
            stream.on('close', function(code, signal)  {
                if(code) cb({code: code, signal: signal});
                //logger.debug("stream closed with code:"+code);
                open_streams--;
            });
            logger.debug("starting streaming");
            product.files.push({filename: part.filename, size: part.byteCount, type: part.headers['content-type']});
            part.pipe(stream);
        });
        /*
        part.on('end', function() {
            logger.info("part ended");
        });
        */
        part.on('error', cb);
    });
    form.parse(req);
}

module.exports = router;

