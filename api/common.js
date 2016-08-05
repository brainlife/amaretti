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
var request = require('request');

//mine
var config = require('../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('./models/db');
//var progress = require('./progress');

exports.getworkdir = function(workflow_id, resource) {
    var detail = config.resources[resource.resource_id];
    //if(detail === undefined) throw new Error("couldn't find resource_id:"+resource.resource_id);
    if(!detail.workdir) return null;
    var template = detail.workdir;
    var workdir = template.replace("__username__", resource.config.username);
    if(workflow_id) workdir+='/'+workflow_id;
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
            
            /*
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
            */

            //encrypt using configured password and resource._id as IV
            if(!resource._id) throw new Error("can't encrypt without resource._id set");
            var iv = resource._id.toString().substr(0, 16); //needs to be 16 bytes
            var key = crypto.pbkdf2Sync(config.sca.resource_enc_password, iv, 100000, 32, 'sha512');
            var c = crypto.createCipheriv(config.sca.resource_cipher_algo, key, iv);
            var e = c.update(resource.config[k], 'utf8', 'hex');
            e += c.final('hex');
            
            //base64 encode and store it back
            resource.config[k] = e;//new Buffer(e, 'binary').toString('base64');
        }
    }
}

//decrypt all config parameter that starts with enc_
exports.decrypt_resource = function(resource) {
    for(var k in resource.config) {
        if(k.indexOf("enc_") === 0) {
            /*
            var salt = resource.salts[k];
            var key = crypto.pbkdf2Sync(config.sca.resource_enc_password, salt.salt.buffer, 100000, 32, 'sha512');
            var decipher = crypto.createDecipheriv(config.sca.resource_cipher_algo, key, salt.iv.buffer);
            resource.config[k] = decipher.update(resource.config[k], 'base64', 'utf8');
            resource.config[k] += decipher.final('utf8'); 
            */
            var iv = resource._id.toString().substr(0, 16); //needs to be 16 bytes
            var key = crypto.pbkdf2Sync(config.sca.resource_enc_password, iv, 100000, 32, 'sha512');
            var c = crypto.createDecipheriv(config.sca.resource_cipher_algo, key, iv);
            //var v = new Buffer(resource.config[k], 'base64').toString('binary');
            var e = c.update(resource.config[k], 'hex', 'utf8');
            e += c.final('utf8');
            resource.config[k] = e;
        }
    }
}

var ssh_conns = {};
exports.get_ssh_connection = function(resource, cb) {
    //see if we already have an active ssh session
    //console.dir(resource);
    var old = ssh_conns[resource._id];
    if(old) {
        logger.debug("reusing previously established ssh connection. # of connections:"+Object.keys(ssh_conns).length);
        return cb(null, old);
    }
    var detail = config.resources[resource.resource_id];
    var conn = new Client();
    conn.on('ready', function() {
        ssh_conns[resource._id] = conn;
        logger.debug("ssh connection ready");
        //logger.debug(detail);
        cb(null, conn);
    });
    conn.on('end', function() {
        logger.debug("ssh connection ended");
        delete ssh_conns[resource._id];
    });
    conn.on('close', function() {
        logger.debug("ssh connection closed");
        delete ssh_conns[resource._id];
    });
    conn.on('error', function(err) {
        logger.error("ssh connection error");
        logger.error(err);
        //cb(err);
        delete ssh_conns[resource._id];
    });
    exports.decrypt_resource(resource);
    conn.connect({
        host: detail.hostname,
        username: resource.config.username,
        privateKey: resource.config.enc_ssh_private,
        keepaliveInterval: 50,
    });
}

//I also need to cache sftp connection.. If I reuse ssh connection to get sftp connection from it, 
//ssh closed connection eventually.
var sftp_conns = {};
exports.get_sftp_connection = function(resource, cb) {
    //console.dir(resource);
    var old = sftp_conns[resource._id];
    if(old) {
        logger.debug("reusing previously established sftp connection. number of connections:"+Object.keys(sftp_conns).length);
        return cb(null, old);
    }
    //get new ssh connection
    exports.get_ssh_connection(resource, function(err, conn) {
        if(err) return cb(err);
        conn.sftp(function(err, sftp) {
            if(err) return cb(err);
            logger.debug("sftp connection ready");
            sftp_conns[resource._id] = sftp;
            cb(null, sftp);
        });
        //TODO - I thinks I should be listening events on sftp (not conn), but doc doesn't mention any event..
        conn.on('end', function() {
            logger.debug("ssh connection ended - used by sftp");
            delete sftp_conns[resource._id];
        });
        conn.on('close', function() {
            logger.debug("ssh connection closed - used by sftp");
            delete sftp_conns[resource._id];
        });
        conn.on('error', function(err) {
            logger.error("ssh connection error - used by sftp");
            logger.error(err);
            //cb(err);
            delete sftp_conns[resource._id];
        });
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

exports.progress = function(key, p, cb) {
    request({
        method: 'POST',
        url: config.progress.api+'/status/'+key, 
        /*
        headers: {
            'Authorization': 'Bearer '+config.progress.jwt,
        }, 
        */
        rejectUnauthorized: false, //this maybe needed if the https server doesn't contain intermediate cert ..
        json: p, 
    }, function(err, res, body){
        if(err) {
            logger.debug(err);
        } else {
            //logger.debug("successfully posted progress update:"+key);
            logger.debug([key, p]);
        }
        if(cb) cb(err, body);
    });
}

//ssh to host using username/password and insert ssh key in ~/.ssh/authorized_keys
exports.ssh_command = function(username, password, host, command, cb) {
    var conn = new Client({/*readyTimeout:1000*60*/});
    var out = "";
    var ready = false;
    var nexted = false;
    conn.on('ready', function() {
        ready = true;
        conn.exec(command, function(err, stream) {
            if (err) {
                conn.end();
                nexted = true;
                return cb(err);
            }
            stream.on('close', function(code, signal) {
                conn.end();
                nexted = true;
                cb(code);
            }).on('data', function(data) {
                out += data;
            }).stderr.on('data', function(data) {
                out += data;
            });
        });
    });
    conn.on('error', function(err) {
        console.error(err.toString());
        //caused by invalid password, etc..
        nexted = true;
        if(err.level && err.level == "client-authentication") {
            cb("Possibly incorrect username / password");
        } else {
            if(err.message) cb(err.message);
            else cb(err.toString());
        }
    });
    conn.on('end', function() {
        if(!ready && !nexted) cb('SSH connection ended before it began.. maybe maintenance day?');
    });
    conn.on('keyboard-interactive', function(name, instructions, lang, prompts, cb) {
        if(~prompts[0].prompt.indexOf("Password:")) cb([$scope.password]);
        else {
           cb("SSH server prompted something that I don't know how to answer");
            console.dir(prompts);
        }
    });
    conn.connect({
        //debug: true,
        port: 22,
        host: host,
        username: username,
        password: password,
        tryKeyboard: true, //in case password auth is disabled
    });
}

/* finds the intersection of 
 * two arrays in a simple fashion.  
 *
 * PARAMS
 *  a - first array, must already be sorted
 *  b - second array, must already be sorted
 *
 * NOTES
 *
 *  Should have O(n) operations, where n is 
 *    n = MIN(a.length(), b.length())
 */
function intersect_safe(a, b)
{
  var ai=0, bi=0;
  var result = [];

  while( ai < a.length && bi < b.length )
  {
     if      (a[ai] < b[bi] ){ ai++; }
     else if (a[ai] > b[bi] ){ bi++; }
     else /* they're equal */
     {
       result.push(a[ai]);
       ai++;
       bi++;
     }
  }

  return result;
}


//return true if user has access to the resource
exports.check_access = function(user, resource) {
    if(resource.user_id == user.sub) return true;
    if(resource.gids && user.gids) {
        var inter = intersect_safe(resource.gids, user.gids);
        if(inter.length) return true;
    }
    return false;
}

exports.create_progress_key = function(instance_id, task_id) {
    var key = "_sca."+instance_id;
    if(task_id) key += "."+task_id;
    return key;
}
