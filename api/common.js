const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const winston = require('winston');
const async = require('async');
const Client = require('ssh2').Client;
const ConnectionQueuer = require('ssh2-multiplexer');
const redis = require('redis');
const request = require('request');

const config = require('../config');
const logger = new winston.Logger(config.logger.winston);
const db = require('./models');
const hpss = require('hpss');

//connect to redis - used to store various shared caches
exports.redis = redis.createClient(config.redis.port, config.redis.server);
exports.redis.on('error', err=>{throw err});

exports.getworkdir = function(workflow_id, resource) {
    var detail = config.resources[resource.resource_id];
    var workdir = resource.config.workdir || detail.workdir;
    if(!workdir) return null;
    var template = workdir;
    var fullpath = template.replace("__username__", resource.config.username);
    if(workflow_id) fullpath+='/'+workflow_id;
    
    //lastly, path.resolve() to get rid of ".." and such
    return path.resolve(fullpath);
}
exports.gettaskdir = function(workflow_id, task_id, resource) {
    var workdir = exports.getworkdir(workflow_id, resource);
    
    //lastly, path.resolve() to get rid of ".." and such
    return path.resolve(workdir+"/"+task_id);
}

//encrypt all config parameter that starts with enc_
exports.encrypt_resource = function(resource) { 
    for(var k in resource.config) {
        if(k.indexOf("enc_") === 0) {
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
//TODO crypto could throw execption - but none of the client are handling it.. 
exports.decrypt_resource = function(resource) {
    if(resource.decrypted) {
        logger.info("resource already decrypted");
        return;
    }
    for(var k in resource.config) {
        if(k.indexOf("enc_") === 0) {
            var iv = resource._id.toString().substr(0, 16); //needs to be 16 bytes
            var key = crypto.pbkdf2Sync(config.sca.resource_enc_password, iv, 100000, 32, 'sha512');
            var c = crypto.createDecipheriv(config.sca.resource_cipher_algo, key, iv);
            var e = c.update(resource.config[k], 'hex', 'utf8');
            e += c.final('utf8');
            resource.config[k] = e;
        }
    }
    resource.decrypted = true;
}

var ssh_conns = {};
exports.get_ssh_connection = function(resource, cb) {
    //see if we already have an active ssh session
    var old = ssh_conns[resource._id];
    //TODO - check to make sure connection is really alive?
    if(old) return cb(null, old);

    //open new connection
    logger.debug("opening new ssh connection for resource:", resource._id.toString());
    var detail = config.resources[resource.resource_id];
    var conn = new Client();
    conn.on('ready', function() {
        logger.debug("ssh connection ready for resource:", resource._id.toString());
        var connq = new ConnectionQueuer(conn);
        ssh_conns[resource._id] = connq;

        if(cb) cb(null, connq); //success!
        cb = null;
    });
    conn.on('end', function() {
        logger.debug("ssh connection ended .. resource:", resource._id.toString());
        delete ssh_conns[resource._id];
    });
    conn.on('close', function() {
        logger.debug("ssh connection closed .. resource:", resource._id.toString());
        delete ssh_conns[resource._id];
    });
    conn.on('error', function(err) {
        logger.error("ssh connectionn error .. resource:", err, resource._id.toString());
        delete ssh_conns[resource._id];
        
        //we want to return connection error to caller, but error could fire after ready event is called. 
        //like timeout, or abnormal disconnect, etc..  need to prevent calling cb twice!
        if(cb) cb(err);
        cb = null;
    });

    exports.decrypt_resource(resource);
    //https://github.com/mscdex/ssh2#client-methods
    conn.connect({
        host: resource.config.hostname || detail.hostname,
        username: resource.config.username,
        privateKey: resource.config.enc_ssh_private,
        keepaliveInterval: 10*1000, //default 0 (disabled)
        //keepaliveCountMax: 30, //default 3 (https://github.com/mscdex/ssh2/issues/367)

        //TODO - increasing readyTimeout doesn't seem to fix "Error: Timed out while waiting for handshake"
        //I think I should re-try connecting instead?
        //readyTimeout: 1000*30, //default 20 seconds (https://github.com/mscdex/ssh2/issues/142)
    });
}

//I need to keep up with sftp connection cache independent of ssh connection pool
var sftp_conns = {};
exports.get_sftp_connection = function(resource, cb) {
    //see if we already have an active sftp session
    var old = sftp_conns[resource._id];
    if(old) {
        //TODO - check to make sure connection is really alive?
        return cb(null, old);
    }
    //open new sftp connection
    var detail = config.resources[resource.resource_id];
    var conn = new Client();
    conn.on('ready', function() {
        logger.debug("new sftp connection ready", resource._id.toString());
        conn.sftp((err, sftp)=>{
            if(err) return cb(err);
            sftp_conns[resource._id] = sftp;
            if(cb) cb(null, sftp);
            cb = null;
        });
    });
    conn.on('end', function() {
        logger.debug("sftp connection ended", resource._id.toString());
        delete sftp_conns[resource._id];
    });
    conn.on('close', function() {
        logger.debug("sftp connection closed", resource._id.toString());
        delete sftp_conns[resource._id];
    });
    conn.on('error', function(err) {
        logger.error("sftp connectionn error", err, resource._id.toString());
        delete sftp_conns[resource._id];

        if(cb) cb(err);
        cb = null;
    });
    exports.decrypt_resource(resource);
    conn.connect({
        host: resource.config.hostname || detail.hostname,
        username: resource.config.username,
        privateKey: resource.config.enc_ssh_private,
        keepaliveInterval: 10*1000, //default 0 (disabled)
        //keepaliveCountMax: 30, //default 3 (https://github.com/mscdex/ssh2/issues/367)
    });
}

exports.report_ssh = function() {
    return {
        ssh_cons: Object.keys(ssh_conns).length,
        sftp_cons: Object.keys(sftp_conns).length,
    }
}

exports.progress = function(key, p, cb) {
    request({
        method: 'POST',
        url: config.progress.api+'/status/'+key, 
        rejectUnauthorized: false, //this maybe needed if the https server doesn't contain intermediate cert ..
        json: p, 
    }, function(err, res, body){
        if(err) {
            logger.debug(err);
        } else {
            logger.debug([key, p]);
        }
        if(cb) cb(err, body);
    });
}

//ssh to host using username/password
//currently only used by sshkey installer
exports.ssh_command = function(username, password, host, command, opts, cb) {
    var conn = new Client({/*readyTimeout:1000*60*/});
    var out = "";
    var ready = false;
    var nexted = false;
    conn.on('ready', function() {
        ready = true;
        conn.exec(command, opts, function(err, stream) {
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
    conn.on('keyboard-interactive', function(name, instructions, lang, prompts, sshcb) {
        if(~prompts[0].prompt.indexOf("Password:")) sshcb([password]);
        else {
            sshcb("SSH server prompted something that I don't know how to answer");
            logger.debug(prompts);
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

exports.get_user_gids = function(user) {
    var gids = user.gids||[];
    gids = gids.concat(config.amaretti.global_groups);
    return gids;
}

//return true if user has access to the resource
exports.check_access = function(user, resource) {
    if(resource.user_id == user.sub) return true;
    if(resource.gids) {
        const gids = exports.get_user_gids(user);
        //find common ids
        let found = false;
        resource.gids.forEach(gid=>{
            if(~gids.indexOf(gid)) found = true;
        });
        if(found) return true;
    }
    return false;
}

exports.create_progress_key = function(instance_id, task_id) {
    var key = "_sca."+instance_id;
    if(task_id) key += "."+task_id;
    return key;
}

//run hsi locally (where sca-wf is running) - used mainly to test the hpss account, and by resource/ls for hpss resource
exports.ls_hpss = function(resource, _path, cb) {
    exports.decrypt_resource(resource);
    var keytab = new Buffer(resource.config.enc_keytab, 'base64');
    //var good_keytab = fs.readFileSync("/home/hayashis/.ssh/soichi-hsi.keytab");
    var context = new hpss.context({
        username: resource.config.username,
        keytab: keytab,
    });    
    context.ls(_path, function(err, files) {
        context.clean();
        cb(err, files); 
    });
}

exports.request_task_removal = function(task, cb) {
    if(task.status == "running"|| task.status == "requested") task.status = "stop_requested";
    else task.status_msg = "Waiting to be removed";
    task.remove_date = new Date();
    task.next_date = undefined;
    task.save(cb);
}

exports.update_instance_status = function(instance_id, cb) {
    db.Instance.findById(instance_id, function(err, instance) {
        if(err) return cb(err);
        if(!instance) return cb("couldn't find instance by id:"+instance_id);

        //find all tasks under this instance
        db.Task.find({instance_id: instance._id}, 'status status_msg', function(err, tasks) {
            if(err) return cb(err);

            //count status
            let counts = {};
            tasks.forEach(function(task) {
                if(counts[task.status] === undefined) counts[task.status] = 0;
                counts[task.status]++;
            });

            //decide instance status (TODO - I still need to adjust this, I feel)
            let newstatus = "unknown";
            if(tasks.length == 0) newstatus = "empty";
            else if(counts.running > 0) newstatus = "running";
            else if(counts.waiting > 0) newstatus = "waiting";
            else if(counts.requested > 0) newstatus = "requested";
            else if(counts.failed > 0) newstatus = "failed";
            else if(counts.finished > 0) newstatus = "finished";
            else if(counts.removed > 0) newstatus = "removed";

            //did status changed?
            if(instance.status != newstatus) {
                logger.debug("instance status changed",instance._id,newstatus);
                if(newstatus == "unknown") logger.debug(counts);
                instance.status = newstatus;
                instance.update_date = new Date();
                instance.save(cb);
            } else cb(); //no change..
        });
    });
}

exports.rerun_task = function(task, remove_date, cb) {
    switch(task.status) {
    //don't need to rerun non-terminated task
    case "running":
    case "running_sync":
    //shouldn't rerun task that's stop_requested
    case "stop_requested":
    //maybe shouldn't rerun if task is stopped?
    //case "stopped":
        return cb();
    }

    //don't rerun if task is already starting
    if(task.start_date && task.status == "requested") {
        return cb();
    }

    //let user reset remove_date, or set it based on last relationship between request_date and remove_date
    if(remove_date) task.remove_date = remove_date;
    else if(task.remove_date) {
        var diff = task.remove_date - task.request_date;
        task.remove_date = new Date();
        task.remove_date.setTime(task.remove_date.getTime() + diff); 
    }

    task.status = "requested";
    task.status_msg = "Re-requested";
    
    //reset things
    task.request_date = new Date();
    task.start_date = undefined;
    task.finish_date = undefined;
    task.products = undefined;
    task.next_date = undefined; //reprocess asap
    task.run = 0;

    task.save(err=>{
        if(err) return next(err);
        exports.update_instance_status(task.instance_id, err=>{
            if(err) return next(err);
            exports.progress(task.progress_key, {status: 'waiting', /*progress: 0,*/ msg: 'Task Re-requested'}, err=>{
                cb(err);
            });
        });
    });
}

exports.get_gids = function(user_id, cb) {
    //look in redis first
    let key = "cache.gids."+user_id;
    exports.redis.exists(key, (err, exists)=>{
        if(err) return cb(err);
        if(exists) {
            exports.redis.lrange(key, 0, -1, cb);
            return;
        } else {
            //load from profile service
            logger.debug("looking up user gids from auth service"); 
            request.get({
                url: config.api.auth+"/user/groups/"+user_id,
                json: true,
                headers: { 'Authorization': 'Bearer '+config.sca.jwt }
            }, function(err, res, gids) {
                if(err) return cb(err);
                switch(res.statusCode) {
                case 404:
                    //often user_id is set to non existing user_id on auth service (like "sca")
                    gids = []; 
                    break;
                case 401:
                    //token is misconfigured?
                    return cb("401 while trying to pull gids from auth service.. bad jwt?");
                case 200:
                    //success! 
                    break;
                default:
                    return cb("invalid status code:"+res.statusCode+" while obtaining user's group ids.. retry later")
                }

                //reply to the caller
                cb(null, gids);
                
                //cache on redis
                gids.unshift(key);
                exports.redis.rpush(gids);
                exports.redis.expire(key, 60); //60 seconds too long?
            });
        }
    });
}

//search inside a list of mongoose ObjectID return position
exports.indexOfObjectId = function(ids, search_id, cb) {
    var pos = -1;
    ids.forEach((id,idx)=>{
        if(id.toString() == search_id.toString()) pos = idx;
    });
    return pos;
}
