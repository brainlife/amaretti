const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const winston = require('winston');
const async = require('async');
const Client = require('ssh2').Client;
const sshagent = require('sshpk-agent');
const ConnectionQueuer = require('ssh2-multiplexer');
const redis = require('redis');
const request = require('request');
const child_process = require('child_process');
const ps = require('ps-node');

const config = require('../config');
const logger = winston.createLogger(config.logger.winston);
const db = require('./models');
const events = require('./events');

//http://locutus.io/php/strings/addslashes/
//http://locutus.io/php/addslashes/
String.prototype.addSlashes = function() {
  return this.replace(/[\\"']/g, '\\$&').replace(/\u0000/g, '\\0')
}

//find all orphaned ssh-agent processes and kill them.
ps.lookup({
    command: 'ssh-agent',
}, (err, list)=>{
    if(err) throw err;
    list.forEach(p=>{
        if(p.ppid == "1") {
            logger.info("killing orphaned ssh-agent");
            console.dir(p);
            process.kill(p.pid);
        }
    });
});

/* doesn't work
process.on('exit', ()=>{
    console.log("exit--------------------------------");
    for(let id in sshagents) {
        if(sshagents[id]) {
            console.log("terminating ssh-agent %s", id);
            sshagents[id].agent.kill();
        }
    }
});
*/

exports.create_sshagent = function(key, cb) {
    let auth_sock = "/tmp/"+Math.random()+"."+Math.random()+"."+Math.random()+".ssh-agent.sock";
    logger.debug("spawning(-D).. ssh-agent for %s", auth_sock);
    let agent = child_process.spawn("ssh-agent", ["-D", "-a", auth_sock]);
    agent.stdout.on('data', data=>{
        logger.debug(data);
    });
    agent.stderr.on('data', data=>{
        logger.error(data);
    });
    agent.on('exit', code=>{
        logger.debug("ssh-agent exited %d %s (as it should)", code, auth_sock);
    });

    //I need to give a bit of time for sshagent to start 
    setTimeout(()=>{
        //this throws if ssh agent isn't running, but try/catch won't catch.. 
        //https://github.com/joyent/node-sshpk-agent/issues/11
        //"expires" in seconds (10 seconds seems to be too short..)
        //TODO - I am not sure if 60 seconds is enough, or that extending it would fix the problem.
        //    [rsync]
        //    Permission denied (publickey).
        //    sync: connection unexpectedly closed (0 bytes received so far) [receiver]
        //common.sshagent_add_key(privkey, {expires: 60}, next);  
        let client = new sshagent.Client({socketPath: auth_sock});

        /* I get.. "SSH agent does not support RFC extension"
        client.listExtensions((err, extensions)=>{
            if(err) logger.error(err);
            console.log("----------------listExtensions");
            console.dir(extensions);
        });
        */
        client.addKey(key, /*{expires: 0},*/ err=>{
            cb(err, agent, client, auth_sock, key);
        });
    }, 1000);
}

//connect to redis - used to store various shared caches
//TODO who use this now?
exports.redis = redis.createClient(config.redis.port, config.redis.server);
exports.redis.on('error', err=>{throw err});

exports.getworkdir = function(workflow_id, resource) {
    //var detail = config.resources[resource.resource_id];
    var workdir = resource.config.workdir;// || detail.workdir;
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

//open ssh connection and wrap it with ConnectionQueuer
var ssh_conns = {};
exports.get_ssh_connection = function(resource, opts, cb) {
    if(typeof opts == "function") {
        cb = opts;
        opts = {};
    }

    //need to create a unique key for resource and any options used
    const hostname = resource.config.hostname;// || detail.hostname;
    const id = JSON.stringify({id: resource._id, hostname, opts});
    
    //see if we already have an active ssh session
    const old = ssh_conns[id];
    if(old) {
        if(old.connecting) {
            //someone is still connecting..
            let old_date = new Date();
            old_date.setSeconds(old_date.getSeconds() - 20);
            if(old.create_date < old_date) {
                console.error("connection reuse timeout.. let's open a new one again");    
                //TODO - how can I abort the open request?
            } else {
                opts.count++;
                logger.info("still connecting.. waiting .. %s", id);
                return setTimeout(()=>{
                    exports.get_ssh_connection(resource, opts, cb);
                }, 1000);
            }
        } else {
            /*
            //we could use the old connection but if it's too old, close it and open new one
            //TODO - what's wrong with an old connection? maybe we could just check to make sure 
            //if it still works?
            if(old.queue.length == 0 && (new Date().getTime() - old.connected) > 1000*3600) {
                logger.info("connection too is old.. (and nobody is using it) re-openinge");
                old.end();
            } else {
                logger.info("reusing ssh(cqueue) connection for %s (queue size:%d) (connected:%s)", id, old.queue.length, old.connected);
                //TODO - should I check to make sure if the connection is still good? then we don't have to
                //close the old connection just because it's old?
                return cb(null, old);
            }
            */

            //test the old connection to make sure it still works..
            //if not, open a news one
            //TODO - need to set timeout?
            old.exec("true", (err, stream)=>{
                if(err) {
                    //no longer working.. we should reconnect
                    old.end();
                    delete ssh_conns[id];
                    exports.get_ssh_connection(resource, opts, cb); //try again..
                } else {
                    return cb(null, old);
                }
            });
            return;
        }
    }

    ssh_conns[id] = {connecting: true, create_date: new Date()};

    //open new connection
    logger.debug("opening new ssh connection (should connect in 30 seconds).. %s", id);
    let connection_timeout = setTimeout(()=>{
        connection_timeout = null;
        console.log("ssh connection timeout...");
        if(cb) cb("ssh connection timeout");
        cb = null;
    }, 1000*30);

    //const detail = config.resources[resource.resource_id];
    const conn = new Client();
    conn.on('ready', ()=>{
        if(!connection_timeout) return; //already timed out
        clearTimeout(connection_timeout);

        logger.info("ssh connection ready .. %s", id);
        const connq = new ConnectionQueuer(conn);
        ssh_conns[id] = connq; //cache
        connq.connected = new Date();
        if(cb) cb(null, connq); //ready!
        cb = null;
    });
    conn.on('end', ()=>{
        logger.info("ssh connection ended .. %s", id);
        delete ssh_conns[id];
    });
    conn.on('close', ()=>{
        logger.info("ssh connection closed .. %s", id);
        delete ssh_conns[id];
    });
    conn.on('error', err=>{
        if(!connection_timeout) return; //already timed out
        clearTimeout(connection_timeout);

        logger.error("ssh connectionn error(%s) .. %s", err, id);
        delete ssh_conns[id];
        //we want to return connection error to caller, but error could fire after ready event is called. 
        //like timeout, or abnormal disconnect, etc..  need to prevent calling cb twice!
        if(cb) cb(err);
        cb = null;
    });

    exports.decrypt_resource(resource);
    //https://github.com/mscdex/ssh2#client-methods
    conn.connect(Object.assign({
        host: hostname,
        username: resource.config.username,
        privateKey: resource.config.enc_ssh_private,

        //setting it longer for csiu
        keepaliveInterval: 15*1000, //default 0 (disabled)
        keepaliveCountMax: 10, //default 3 (https://github.com/mscdex/ssh2/issues/367)

        //TODO - increasing readyTimeout doesn't seem to fix "Error: Timed out while waiting for handshake"
        //I think I should re-try connecting instead?
        //readyTimeout: 1000*30, //default 20 seconds (https://github.com/mscdex/ssh2/issues/142)

        tryKeyboard: true, //needed by stampede2
    }, opts));
}

function sftp_ref(sftp) {
    sftp._count = 0;

    function stat(path, cb) {
        sftp._count++;
        sftp.stat(path, (err, stat)=>{
            sftp._count--;
            cb(err, stat);
        });
    }

    function readdir(path, cb) {
        sftp._count++;
        sftp.readdir(path, (err, files)=>{
            sftp._count--;
            cb(err, files);
        });
    }

    function realpath(path, cb) {
        sftp._count++;
        sftp.realpath(path, (err, path)=>{
            sftp._count--;
            cb(err, path);
        });
    }

    function createReadStream(path, cb) {
        //prevent more than 5 concurrent connection (most places only allows up to 8)
        if(sftp._count > 4) {
            logger.info("waiting sftp._count", sftp._count);
            return setTimeout(()=>{
                createReadStream(path, cb);
            }, 3000);
        }
        sftp._count++;
        logger.debug("createReadStream sftp._count:", sftp._count);
        let stream = sftp.createReadStream(path);

        //10 minutes isn't enough for azure/vm to send output_fe.mat (1.2G) 
        //(todo). but output_fe.mat could be as big as 6G!
        let stream_timeout = setTimeout(()=>{
            logger.error("readstream timeout.. force closing");
            stream.close();
        }, 1000*60*30); 

        stream.on('close', ()=>{
            clearTimeout(stream_timeout);
            //this gets fired if stream 'error' (due to missing path)
            //'ready' doesn't fire for stream
            //'finish' doesn't fire for stream
            sftp._count--;
            logger.debug("createreadstream closed _count:", sftp._count);
        });
        cb(null, stream);
    }

    function createWriteStream(path, cb) {
        logger.debug("createWriteStream", sftp._count);
        if(sftp._count > 4) {
            return setTimeout(()=>{
                createWriteStream(path, cb);
            }, 1000);
        }
        sftp._count++;
        let stream = sftp.createWriteStream(path);
        let stream_timeout = setTimeout(()=>{
            logger.error("writestream timeout.. force closing");
            stream.close();
        }, 1000*60*30); 
        stream.on('close', ()=>{
            clearTimeout(stream_timeout);
            logger.debug("createwritestream close");
            sftp._count--;
        });
        cb(null, stream);
    }
    
    return { stat, readdir, createReadStream, createWriteStream, realpath };
}

//I need to keep up with sftp connection cache independent of ssh connection pool
//TODO - won't this run out of sftp channel for a resource if too many requests are made?
var sftp_conns = {};
exports.get_sftp_connection = function(resource, cb) {

    const hostname = resource.config.hostname;// || detail.hostname;
    const id = JSON.stringify({id: resource._id, hostname});
    
    //see if we already have an active sftp session
    var old = sftp_conns[id];
    if(old) {
        if(old.connecting) {
            logger.info("waiting for connecting sftp .. %s", id);
            return setTimeout(()=>{
                exports.get_sftp_connection(resource, cb);
            }, 1000);
        }

        //if connection is too old, close it and open new one
        if(old._count == 0 && (new Date().getTime() - old.connected) > 1000*3600) {
            logger.info("sftp connection is old.. opening new one %s", id);
            old.end();
        } else {
            logger.debug("reusing sftp for resource %s", id);
            return cb(null, old);
        }
    }
    sftp_conns[id] = {connecting: true};

    logger.debug("opening new sftp connection");
    let connection_timeout = setTimeout(()=>{
        connection_timeout = null;
        console.log("ssh connection timeout...");
        if(cb) cb("ssh connection timeout");
        cb = null;
    }, 1000*30);

    //const detail = config.resources[resource.resource_id];
    const conn = new Client();
    conn.on('ready', function() {
        if(!connection_timeout) return; //already timed out
        clearTimeout(connection_timeout);

        logger.debug("new ssh for sftp connection ready.. opening sftp %s", id);
        let t = setTimeout(()=>{
            logger.error("got ssh connection but not sftp..");
            delete sftp_conns[id];
            if(cb) cb(err);
            cb = null;
            t = null;
        }, 10*1000); //6sec too short for osgconnect
        conn.sftp((err, sftp)=>{
            if(!t) {
                logger.error("it timed out while obtaining sftp connection.. should I close sftp connection?");
                return; //timed out already
            }
            clearTimeout(t);
            if(err) {
                logger.error(err);
                if(cb) cb(err);
                cb = null;
                return;
            }
            sftp = sftp_ref(sftp);
            sftp._workdir = exports.getworkdir(null, resource); //to be used by tester
            sftp_conns[id] = sftp;
            if(cb) cb(null, sftp);
            cb = null;
        });
    });
    conn.on('end', function() {
        logger.debug("sftp connection ended %s", id);
        delete sftp_conns[id];
    });
    conn.on('close', function() {
        logger.debug("sftp connection closed %s", id);
        delete sftp_conns[id];
    });
    conn.on('error', function(err) {
        if(!connection_timeout) return; //already timed out
        clearTimeout(connection_timeout);

        logger.error("sftp connectionn error(%s) .. %s", err, id);
        //console.error(sftp_conns[id]);
        delete sftp_conns[id];

        //we want to return connection error to caller, but error could fire after ready event is called. 
        //like timeout, or abnormal disconnect, etc..  need to prevent calling cb twice!
        if(cb) cb(err);
        cb = null;
    });
    exports.decrypt_resource(resource);
    conn.connect({
        host: hostname,
        username: resource.config.username,
        privateKey: resource.config.enc_ssh_private,
        keepaliveInterval: 10*1000, //default 0 (disabled)
        //keepaliveCountMax: 10, //default 3 (https://github.com/mscdex/ssh2/issues/367)
        tryKeyboard: true, //needed by stampede2
    });
}

exports.report_ssh = function() {
    return {
        ssh_cons: Object.keys(ssh_conns).length,
        sftp_cons: Object.keys(sftp_conns).length,
        //sftp_status, 
    }
}

/* //deprecated 
exports.progress = function(key, p, cb) {
    logger.warn("common.progress is deprecated");
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
*/

//*
//TODO should I deprecate this?
//ssh to host using username/password
//currently only used by sshkey installer
/*
exports.ssh_command = function(username, password, host, command, opts, cb) {
    var conn = new Client();
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
*/

//TODO who uses this?
/*
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
*/

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

/*
exports.create_progress_key = function(instance_id, task_id) {
    var key = "_sca."+instance_id;
    if(task_id) key += "."+task_id;
    return key;
}
*/

/*
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
*/

exports.request_task_removal = function(task, cb) {
    //running jobs needs to be stopped first
    switch(task.status) {
    case "waiting": //should be deprecated now .. but still exists
    case "running":
        //TODO - if task handler is currently checking status for this task, this update could be 
        //overwritten.. #20
        task.status = "stop_requested";
        task.status_msg = "Task will be stopped and removed";
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
        //we don't have a way to stop running_rsync.. I think.. just wait for it to finish 
        //(then let housekeeper take care of the removal)
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
        db.Task.find({
            instance_id: instance._id, 
            "config._tid": {$exists: 1}, //let's only count UI tasks
        })
        .sort({create_date: 1})
        .select('status status_msg service name user_id config._tid')
        .exec((err, tasks)=>{
            if(err) return cb(err);

            //count status
            let counts = {};
            tasks.forEach(function(task) {
                //ignore staging tasks (to be more consistent with how UI counts task)
                if(task.service == "brainlife/app-stage") return;
                if(task.service == "brainlife/app-archive") return;

                if(counts[task.status] === undefined) counts[task.status] = 0;
                counts[task.status]++;
            });

            //decide instance status
            let newstatus = "unknown";
            //if(tasks.length == 0) newstatus = "empty";
            if(Object.keys(counts).length == 0) newstatus = "empty";
            else if(counts.running > 0) newstatus = "running";
            else if(counts.requested > 0) newstatus = "requested";
            else if(counts.failed > 0) newstatus = "failed";
            else if(counts.finished > 0) newstatus = "finished";
            else if(counts.removed > 0) newstatus = "removed";
            else if(counts.stop_requested> 0) newstatus = "stop_requested";
            else if(counts.stopped > 0) newstatus = "stopped";

            if(newstatus == "unknown") {
                logger.error("can't figure out instance status", instance._id.toString());
                logger.error(JSON.stringify(counts, null, 4));
            }

            let status_changed = false;
            if(instance.status != newstatus) status_changed = true;
            
            //create task summary
            if(!instance.config) instance.config = {};
            instance.config.counts = counts; //TODO - counts can be deduced from summary.. but instance/count api uses this 
            instance.config.summary = [];
            tasks.forEach(task=>{
                if(task.status == "removed") return; //hide removed tasks

                //some task doesn't have _tid set... for somereason
                if(!task.config) task.config = {};
                if(!task.config._tid) task.config._tid = 0;
                
                instance.config.summary.push({
                    tid: task.config._tid,
                    task_id: task._id, 
                    user_id: task.user_id, 
                    service: task.service, 
                    status: task.status, 
                    name: task.name, 
                }); 
            });
            instance.markModified("config"); //nested object aren't tracked by mongoose
            instance.status = newstatus;
            instance.update_date = new Date();
            instance.save(cb);

            //logger.debug("updating instance status");
            //logger.debug(JSON.stringify(instance.config, null, 4));

            let instance_o = instance.toObject();
            instance_o._status_changed = status_changed;
            events.instance(instance_o);
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
    //"removed" job needs to be rerun for novnc.. but it was filtered out.. why didn't do that? git commit doesn't say much
    }

    //don't rerun if task is already starting
    if(task.start_date && task.status == "requested") {
        return cb();
    }

    //don't rerun task that's locked
    if(task.locked) return cb("task is locked");

    //check to see if any deps tasks are running currently using this task.
    db.Task.findOne({ 
        deps: task._id, 
        status: {$in: [ "requested", "running", "running_sync" ]} 
    }).countDocuments((err, count)=>{
        if(err) next(err);
        if(count > 0) {
            //TODO - rerunning task with active deps might not be always bad - if the tasks are in different resource.
            //let's not veto this completely.. I need to think more
            logger.warn("rerunning task with active deps - it might make the deps fail");
            //return cb("Can't rerun this task as it has dependent tasks that are currrently running.");
        }

        //all good! let's proceed with rerunning
        
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
        task.walltime = undefined;
        task.product = undefined; //deprecated by taskproduct
        task.next_date = undefined; //reprocess asap
        task.resource_id = undefined;

        //if user rerun.. then all existing task dirs are invalidated.
        //TODO - we need to clear this, but I should probably remove existing taskdir
        task.resource_ids = []; 

        task.run = 0;
        task.request_count = 0;

        task.save(err=>{
            if(err) return next(err);
            exports.update_instance_status(task.instance_id, err=>{
                if(err) return next(err);
                cb(err);
            });
        });
    });
}

/*
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
*/

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

//copied from warehouse/ common.js
exports.escape_dot = function(obj) {
    if(typeof obj == "object") {
        for(let key in obj) {
            exports.escape_dot(obj[key]);
            if(key.includes(".")) {
                let newkey = key.replace(/\./g, '-');
                obj[newkey] = obj[key];
                delete obj[key];
            }
        }
    }
    return obj;
}

