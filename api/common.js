'use strict';

//node
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

//contrib
var winston = require('winston');
var async = require('async');

//mine
var config = require('./config');
var logger = new winston.Logger(config.logger.winston);
var db = require('./models/db');
var progress = require('./progress');

exports.getworkdir = function(workflow_id, resource) {
    var detail = config.resources[resource.resource_id];
    var template = detail.workdir;
    var workdir = template
        .replace("__username__", resource.config.username)
        .replace("__workflowid__", workflow_id);
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

            //create cipher
            var key = crypto.pbkdf2Sync(config.sca.resource_enc_password, salt, 100000, 32, 'sha512');//, config.sca.resource_pbkdf2_algo);
            var cipher = crypto.createCipheriv(config.sca.resource_cipher_algo, key, iv);
            resource.config[k] = cipher.update(v, 'utf8', 'base64');
            resource.config[k] += cipher.final('base64');
        }
    }
}

//decrypt all config parameter that starts with enc_
exports.decrypt_resource = function(resource) {
    for(var k in resource.config) {
        if(k.indexOf("enc_") === 0) {
            var salt = resource.salts[k];
            var key = crypto.pbkdf2Sync(config.sca.resource_enc_password, salt.salt.buffer, 100000, 32, 'sha512');//, config.sca.resource_pbkdf2_algo);
            var decipher = crypto.createDecipheriv(config.sca.resource_cipher_algo, key, salt.iv.buffer);
            resource.config[k] = decipher.update(resource.config[k], 'base64', 'utf8');
            resource.config[k] += decipher.final('utf8'); 
            //console.log("unecnrypted");
            //console.log(resource.config[k]);
        }
    }
}

