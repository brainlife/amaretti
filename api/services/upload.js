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
    var step_idx = req.query.s;
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
                step_idx: step_idx,
                user_id: req.user.sub,
                service_id: 'upload', 
                status: 'requested',
                resources: {compute: resource_id},
                //config: {}, 
            });
            var path = common.gettaskdir(workflow_id, task._id, resource);

            //open ssh connection to remote compute resource
            var conn = new Client();
            conn.on('ready', function() {
                //now stream data from req to compute resource
                stream_form(req, conn, path, function(err, files, fields) {
                    if(err) next(err);

                    //I don't need ssh connection anymore
                    conn.end();
                    
                    //var products = get_products(files, fields);
                    task.name = fields.name;
                    task.config = fields;
                    task.config.files = files;
                    task.progress_key = "_sca."+workflow._id+"."+task._id;
                    task.save(function(err) {
                        if(err) next(err);
                        workflow.steps[step_idx].tasks.push(task._id);
                        workflow.save(function(err) {
                            res.json({message: "Task Registered", task: task});
                        });
                    });
                    /*
                    conn.exec("cat > "+path+"/config.json", function(err, stream) {
                        if(err) next(err);
                        stream.on('close', function() {
                            //now I can close ssh
                            conn.end();
                            //store product info on the task document.
                            task.name = fields.name;
                            task.products = products;
                            task.status = 'requested';
                            task.save(function(err) {
                                workflow.steps[step_id].tasks.push(task._id);
                                workflow.save(function(err) {
                                    if(err) return next(err);
                                    res.json(task);
                                });
                            });
                        })
                        stream.write(JSON.stringify(products, null, 4));
                        stream.end();
                    });
                    */
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

/*
function get_products(files, fields) {
    var products = [];
    if(fields.type == "bio/fasta") {    
        //create separate products for each files
        files.forEach(function(file) {
            products.push({type: fields.type, fasta: file});
        });
    } else {
        //just put everything under files..
        products.push({type: fields.type, files: files});        
    }
    return products;
}
*/

function stream_form(req, conn, path, cb) {
    //now start parsing
    var open_streams = 0;
    var form = new multiparty.Form({autoFields: true});
    var files = [];
    var fields = {};

    form.on('error', cb);
    form.on('close', alldone);

    function alldone() {
        if(open_streams == 0) {
            //logger.info("all done");
            cb(null, files, fields);
        } else {
            //I need to wait for all stream to close before moving on..
            logger.info("waiting for streams to close (remaining:"+open_streams+")");
            setTimeout(alldone, 1000);
        }
    };
    form.on('field', function(name, value) {
        //TODO validate?
        /*
        switch(name) {
        case "task[name]": task.name = value; break;
        case "task[type]": product.type = value; break;
        default: 
            logger.error("unknown field name:"+name);
        }
        */
        fields[name] = value;
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
            files.push({filename: part.filename, size: part.byteCount, type: part.headers['content-type']});
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

