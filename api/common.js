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

//http://locutus.io/php/strings/addslashes/
String.prototype.addSlashes = function() {
  //  discuss at: http://locutus.io/php/addslashes/
  // original by: Kevin van Zonneveld (http://kvz.io)
  // improved by: Ates Goral (http://magnetiq.com)
  // improved by: marrtins
  // improved by: Nate
  // improved by: Onno Marsman (https://twitter.com/onnomarsman)
  // improved by: Brett Zamir (http://brett-zamir.me)
  // improved by: Oskar Larsson Högfeldt (http://oskar-lh.name/)
  //    input by: Denny Wardhana
  //   example 1: addslashes("kevin's birthday")
  //   returns 1: "kevin\\'s birthday"
  return this.replace(/[\\"']/g, '\\$&').replace(/\u0000/g, '\\0')
}

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
            var key = crypto.pbkdf2Sync(config.amaretti.resource_enc_password, iv, 100000, 32, 'sha512');
            var c = crypto.createCipheriv(config.amaretti.resource_cipher_algo, key, iv);
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
            var key = crypto.pbkdf2Sync(config.amaretti.resource_enc_password, iv, 100000, 32, 'sha512');
            var c = crypto.createDecipheriv(config.amaretti.resource_cipher_algo, key, iv);
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
    let old = ssh_conns[resource._id];
    if(old) {
        if(old.connecting) {
            logger.debug("still connecting.. postponing");
            return setTimeout(()=>{
                exports.get_ssh_connection(resource, cb);
            }, 1000);
        }

        logger.debug("reusing ssh(cqueue) connection for", resource._id.toString());
        logger.debug("queue len:", old.queue.length, "remaining channels:", old.counter);
        return cb(null, old);
    }
    ssh_conns[resource._id] = {connecting: new Date()};

    //open new connection
    logger.debug("opening new ssh connection for resource:", resource._id.toString());
    var detail = config.resources[resource.resource_id];
    var conn = new Client();
    conn.on('ready', function() {
        logger.debug("ssh connection ready for resource:", resource._id.toString());
        var connq = new ConnectionQueuer(conn);
        ssh_conns[resource._id] = connq;
        if(cb) cb(null, connq); //ready!
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
//TODO - won't this run out of sftp channel for a resource if too many requests are made?
var sftp_conns = {};
exports.get_sftp_connection = function(resource, cb) {
    //see if we already have an active sftp session
    var old = sftp_conns[resource._id];
    if(old) {
        logger.debug("reusing sftp for resource:"+resource._id);
        return cb(null, old);
    }
    logger.debug("open new sftp connection");
    var detail = config.resources[resource.resource_id];
    var conn = new Client();
    conn.on('ready', function() {
        logger.debug("new sftp connection ready", resource._id.toString());
        conn.sftp((err, sftp)=>{
            if(err) return cb(err);
            sftp._workdir = exports.getworkdir(null, resource); //to be used by tester
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
        console.error(sftp_conns[resource._id]);
        delete sftp_conns[resource._id];

        //we want to return connection error to caller, but error could fire after ready event is called. 
        //like timeout, or abnormal disconnect, etc..  need to prevent calling cb twice!
        if(cb) cb(err);
        cb = null;
    });
    exports.decrypt_resource(resource);
    conn.connect({
        host: resource.config.hostname || detail.hostname,
        username: resource.config.username,
        privateKey: resource.config.enc_ssh_private,
        keepaliveInterval: 10*1000, //default 0 (disabled)
        //keepaliveCountMax: 10, //default 3 (https://github.com/mscdex/ssh2/issues/367)
    });
}

exports.report_ssh = function() {
    return {
        ssh_cons: Object.keys(ssh_conns).length,
        sftp_cons: Object.keys(sftp_conns).length,
        //sftp_status, 
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

//TODO should I deprecate this?
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
        port: 22,
        host: host,
        username: username,
        password: password,
        tryKeyboard: true, //in case password auth is disabled
    });
}

exports.ssh_stat = function(conn, path, cb) {
    //console.log("-----------statting--------------------");
    conn.exec("stat --format='%s %F' "+path, (err, stream)=>{
        if(err) return cb(err);
		let out = "";
		stream.on('error', cb);
		stream.on('close', code=>{
			//console.log("read stream closed", code);
			if(code != 0) return cb("stat failed "+code);
			let tokens = out.trim().split(" ");	
			let size = parseInt(tokens[0]);
			let dir = false;
			if(tokens[1] == "directory") dir = true;
            //console.log("-----------done statting--------------------");
			cb(null, { size, dir });
		});
		stream.on('data', data=>{
            //console.log(data.toString());
			out+=data.toString();
		});
		stream.stderr.on('data', data=>{
			logger.error(data.toString());
		});
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
    //running jobs needs to be stopped first
    switch(task.status) {
    case "waiting": //should be deprecated now .. but still exists
    case "running":
        task.status = "stop_requested";
        task.status_msg = "Task needs to be stopped and removed";
        break;
    case "requested":
        if(task.start_date) {
            //we can't stop "staring" task.. so let's just make sure it stops as soon as it starts up
            task.max_runtime = 0;
            task.status_msg = "Task scheduled to be stopped soon and be removed";
        } else {
            task.status = "stopped"; //not yet started.. just stop
            task.status_msg = "Task stopped";
        }
        break;
    /*
    case "waiting":
        task.status = "stopped";
        break;
    */
    case "running_sync":
        //we don't have a way to stop running_rsync.. I think.. just wait for it to be stopped
        break;
    default:
        task.status_msg = "Task scheduled to be removed soon";
    }

    //set remove_date to now so that the task will be cleaned up by house keeper immediately
    task.remove_date = new Date();
    task.next_date = undefined;
    task.save(cb);
}

exports.update_instance_status = function(instance_id, cb) {
    db.Instance.findById(instance_id, function(err, instance) {
        if(err) return cb(err);
        if(!instance) return cb("couldn't find instance by id:"+instance_id);

        //find all tasks under this instance
        //db.Task.find({instance_id: instance._id, status: {$ne: "removed"}})
        db.Task.find({instance_id: instance._id})
        .sort({create_date: 1})
        .select('status status_msg service name user_id')
        .exec((err, tasks)=>{
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
            else if(counts.requested > 0) newstatus = "requested";
            else if(counts.failed > 0) newstatus = "failed";
            else if(counts.finished > 0) newstatus = "finished";
            else if(counts.removed > 0) newstatus = "removed";

            if(newstatus == "unknown") {
                logger.error("can't figure out instance status", instance._id.toString());
                logger.error(counts);
            }
            
            //create task summary
            if(!instance.config) instance.config = {};
            instance.config.summary = [];
            tasks.forEach(task=>{
                if(task.status == "removed") return; //hide removed tasks
                instance.config.summary.push({
                    task_id: task._id, 
                    user_id: task.user_id, 
                    service: task.service, 
                    status: task.status, 
                    name: task.name, 
                }); 
            });
            instance.markModified("config");

            instance.status = newstatus;
            instance.update_date = new Date();
            instance.save(cb);
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
        if(diff < 0) {
            logger.error("remove_date is before request_date.. unsetting remove_date..  this shouldn't happen but it does.. investigate");
            task.remove_date = undefined;
        } else {
            task.remove_date = new Date();
            task.remove_date.setTime(task.remove_date.getTime() + diff); 
        }
    }

    task.status = "requested";
    task.status_msg = "Waiting to be started";
    
    //reset things
    task.request_date = new Date();
    task.start_date = undefined;
    task.finish_date = undefined;
    task.products = undefined;
    task.next_date = undefined; //reprocess asap
    task.run = 0;
    task.request_count = 0;

    task.save(err=>{
        if(err) return next(err);
        exports.update_instance_status(task.instance_id, err=>{
            if(err) return next(err);
            cb(err);
        });
    });
}

exports.get_gids = function(user_id, cb) {
    //look in redis first
    let key = "cache.gids."+user_id;
    let ekey = "cache.gids."+user_id+".exists"; //we can't store empty array but we want to cache that..
    exports.redis.exists(ekey, (err, exists)=>{
        if(err) return cb(err);
        if(exists) {
            exports.redis.lrange(key, 0, -1, cb); //return all gids
            return;
        } else {
            //load from profile service
            logger.debug("cache miss.. looking up user gids from auth service", key); 
            request.get({
                url: config.api.auth+"/user/groups/"+user_id,
                json: true,
                headers: { 'Authorization': 'Bearer '+config.amaretti.jwt }
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
                
                //cache on redis (can't rpush empty list to redis)
                if(gids.length == 0) {
                    //logger.warn("gids empty.", key);
                    exports.redis.set(ekey, "empty");
                    exports.redis.expire(ekey, 60); //60 seconds too long?
                    return;
                } else {
                    gids.unshift(key);
                    exports.redis.set(ekey, "not empty");
                    exports.redis.expire(ekey, 60); //60 seconds too long?
                    exports.redis.rpush(gids);
                    exports.redis.expire(key, 60); //60 seconds too long?
                }
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

/*
exports.set_conn_timeout = function(cqueue, stream, time) {
    var timeout = setTimeout(()=>{
        //logger.error("reached connection timeout.. closing ssh connection (including other sessions..)");
        logger.error("reached connection timeout.. closing ssh connection");
        //stream.close() won't do anything, so the only option is to close the whole connection 
        //https://github.com/mscdex/ssh2/issues/339
        cqueue.end();
        //stream.close(); //seems to work now?
    }, time);
    stream.on('close', (code, signal)=>{
        logger.debug("exec closed!");
        clearTimeout(timeout);
    });
}
*/

