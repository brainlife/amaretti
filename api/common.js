'use strict';

//node
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

//contrib
var winston = require('winston');
var async = require('async');
var keygen = require('ssh-keygen');
var Client = require('ssh2').Client;

//mine
var config = require('./config');
var logger = new winston.Logger(config.logger.winston);
var db = require('./models/db');
var progress = require('./progress');

exports.getworkdir = function(workflow_id, resource) {
    var detail = config.resources[resource.resource_id];
    var template = detail.workdir;
    var workdir = template
        .replace("__username__", resource.config.username);
    //    .replace("__workflowid__", workflow_id);
    workdir+='/'+workflow_id;
    return workdir; 
}
exports.gettaskdir = function(workflow_id, task_id, resource) {
    var workdir = exports.getworkdir(workflow_id, resource);
    return workdir+"/"+task_id;
}

//encrypt all config parameter that starts with enc_
exports.encrypt_resource = function(resource) { 
    for(var k in resource.config) {
        if(k.indexOf("enc_") === 0) {
            var v = resource.config[k];
            
            //generate salt
            var salt = new Buffer(crypto.randomBytes(32)); //ensure that the IV (initialization vector) is random
            var iv = new Buffer(crypto.randomBytes(16)); //ensure that the IV (initialization vector) is random
            if(!resource.salts) resource.salts = {};
            resource.salts[k] = {salt: salt, iv: iv};
            //resource.markModified('salts');

            //create cipher
            var key = crypto.pbkdf2Sync(config.sca.resource_enc_password, salt, 100000, 32, 'sha512');//, config.sca.resource_pbkdf2_algo);
            var cipher = crypto.createCipheriv(config.sca.resource_cipher_algo, key, iv);
            resource.config[k] = cipher.update(v, 'utf8', 'base64');
            resource.config[k] += cipher.final('base64');
            //resource.markModified('config');
        }
    }
}

//decrypt all config parameter that starts with enc_
exports.decrypt_resource = function(resource) {
    for(var k in resource.config) {
        if(k.indexOf("enc_") === 0) {
            var salt = resource.salts[k];
            var key = crypto.pbkdf2Sync(config.sca.resource_enc_password, salt.salt.buffer, 100000, 32, 'sha512');
            var decipher = crypto.createDecipheriv(config.sca.resource_cipher_algo, key, salt.iv.buffer);
            resource.config[k] = decipher.update(resource.config[k], 'base64', 'utf8');
            resource.config[k] += decipher.final('utf8'); 
        }
    }
}

var ssh_conns = {};
exports.get_ssh_connection = function(resource, cb) {
    if(ssh_conns[resource._id]) return cb(ssh_conns[resource._id]);
    var detail = config.resources[resource.resource_id];
    var conn = new Client();
    conn.on('ready', function() {
        ssh_conns[resource._id] = conn;
        logger.debug("connected");
        logger.debug(detail);
        cb(conn);
    });
    conn.on('end', function() {
        logger.debug("connection closed");
        delete ssh_conns[resource._id];
    });
    conn.on('error', function(err) {
        logger.error(err);
    });
    exports.decrypt_resource(resource);
    conn.connect({
        host: detail.hostname,
        username: resource.config.username,
        privateKey: resource.config.enc_ssh_private,
    });
}

exports.ssh_keygen = function(cb) {
    logger.info("generating ssh key");
    //this just calls ssh-keygen..
    keygen({
      //location: location,
      //comment: "",
      //password: password, 
      read: true
    }, function(err, out) {
        if(err) cb(err);
        cb(null, {
            pubkey: out.pubKey.trim(),
            key: out.key.trim(),
        });
    });
}

/*
var services = null;
exports.getServices = function(cb) {
    //use cache
    if(services) return cb(null, services);
    
    //load for the first time
    services = {};
    var services_dir = __dirname+'/../services';
    fs.readdir(services_dir, function(err, files) {
        if(err) return cb(err);
        files.forEach(function(file) {
            try {
                var p = require(services_dir+'/'+file+'/package.json');
                services[p.name] = p;
            } catch(e) {
                console.error("failed to register service:"+file);
                console.error(e);
            }
        });
        cb(null, services);
    });
}

var products = null;
exports.getProducts = function(cb) {
    //use cache
    if(products) return cb(null, products);

    //load for the first time
    products = {};
    var products_dir = __dirname+'/../products';
    fs.readdir(products_dir, function(err, files) {
        if(err) return cb(err);
        files.forEach(function(file) {
            try {
                var p = require(products_dir+'/'+file+'/package.json');
                products[p.name] = p;
            } catch(e) {
                console.error("failed to register product:"+file);
                console.error(e);
            }
        });
        cb(null, products);
    });
}

var workflows = null;
exports.getWorkflows = function(cb) {
    //use cache
    if(workflows) return cb(null, workflows);

    //load for the first time
    workflows = {};
    var workflows_dir = __dirname+'/../workflows';
    fs.readdir(workflows_dir, function(err, files) {
        if(err) return cb(err);
        files.forEach(function(file) {
            try {
                var p = require(workflows_dir+'/'+file+'/package.json');
                workflows[p.name] = p;
            } catch(e) {
                console.error("failed to register workflow:"+file);
                console.error(e);
            }
        });
        cb(null, workflows);
    });
}
*/
