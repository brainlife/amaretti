
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const winston = require('winston');
const async = require('async');
const Client = require('ssh2').Client;
const sshagent = require('sshpk-agent');
const ConnectionQueuer = require('ssh2-multiplexer');
//const redis = require('redis');
const request = require('request');
const child_process = require('child_process');
const ps = require('ps-node');
const jwt = require('express-jwt');

const config = require('../config');
const db = require('./models');
const events = require('./events');

/* patched on git@github.com:soichih/ssh2-multiplexer.git
//override ConnectionQueuer for temporary exception catch fix
ConnectionQueuer.prototype.start = function () {
  var self = this;
  if (!this.running) {
    this.running = true;
    this.interval = setInterval(function () {
      if(self.counter > 0) {
        var saux = self.queue.shift();
        if (self.queue.length < 1) {
          self.stop();
        }
        if (saux !== undefined) {
          self.counter--;
          try {
              self.connection.exec(saux.cmd, saux.options, function (err, stream) {
                if (err) {
                  self.counter++;
                } else {
                  stream.on('exit', function (code, signal) {
                    self.counter++;
                  });
                }
                if (saux.callback !== undefined) {
                  saux.callback(err, stream);
                }
              });
          } catch (err) {
            self.counter++;
            console.error(err);
            if (saux.callback !== undefined) {
              saux.callback(err);
            }
          }
        }
      } else {
        console.debug('Queueing...');
      }
    }, 100);
  }
};
*/

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
            console.log("killing orphaned ssh-agent");
            console.dir(p);
            process.kill(p.pid);
        }
    });
});

exports.create_sshagent = function(key, cb) {
    let auth_sock = "/tmp/"+Math.random()+"."+Math.random()+"."+Math.random()+".ssh-agent.sock";
    //console.debug("spawning(-D).. ssh-agent for %s", auth_sock);
    let agent = child_process.spawn("ssh-agent", ["-D", "-a", auth_sock]);
    agent.stdout.on('data', data=>{
        //console.debug(data);
    });
    agent.stderr.on('data', data=>{
        console.error(data.toString());
    });
    agent.on('exit', code=>{
        //console.debug("ssh-agent exited %d %s (as it should)", code, auth_sock);
    });

    //I need to give a bit of time for sshagent to start 
    setTimeout(()=>{
        let client = new sshagent.Client({socketPath: auth_sock});
        client.addKey(key, /*{expires: 0},*/ err=>{
            cb(err, agent, client, auth_sock, key);
        });
        
        //https://github.com/joyent/node-sshpk-agent/issues/24
        client.on('error', err=>{
            console.error("create_sshagent", err);
            //cb(err);
        })
    }, 1500);
}

//connect to redis - used to store various shared caches
//TODO who use this now?
/*
exports.redis = redis.createClient(config.redis.port, config.redis.server);
exports.redis.on('error', err=>{throw err});
*/

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
        console.log("resource already decrypted");
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
            //other thread is still connecting.. let's wait
            let old_date = new Date();
            old_date.setSeconds(old_date.getSeconds() - 20);
            if(old.create_date < old_date) {
                console.error("ssh_cons: connection reuse timeout.. let's open a new one again");    
                //TODO - how can I abort the open request?
            } else {
                console.debug("ssh_cons: other thread still connecting.. waiting");
                return setTimeout(()=>{
                    exports.get_ssh_connection(resource, opts, cb);
                }, 1000);
            }
        } else {
            //reuse and reduce
            console.log("ssh_cons reusing", id);
            cb(null, old);
            return;
        }
    }

    ssh_conns[id] = {connecting: true, create_date: new Date()};

    //open new connection
    let connection_timeout = setTimeout(()=>{
        connection_timeout = null;
        console.error("ssh_cons: ssh connection timeout...");
        if(cb) cb("ssh connection timeout");
        cb = null;
    }, 1000*30);

    const conn = new Client();
    conn.on('ready', ()=>{
        if(!connection_timeout) return; //already timed out
        clearTimeout(connection_timeout);

        console.log("ssh_cons: ssh connection ready .. creating connecitonQueuer %s", id);
        const connq = new ConnectionQueuer(conn, {maxChannels: 6});
        ssh_conns[id] = connq; //cache
        connq.connected = new Date();

        if(cb) {
            cb(null, connq); //ready!
            cb = null;
        } else {
            console.error("ssh2 client connection is ready but cb() is already called..")
        }
    });
    conn.on('end', ()=>{
        console.log("ssh_cons: ssh socket disconnected", id);
        delete ssh_conns[id];
    });
    conn.on('close', ()=>{
        console.log("ssh_cons: ssh socket closed", id);
        delete ssh_conns[id];
    });

    //assume error only happens before ready?
    conn.on('error', err=>{
        if(!connection_timeout) return; //already timed out (don't care about this error anymore)
        clearTimeout(connection_timeout);

        console.error("ssh_cons ssh connectionn error(%s) .. %s", err, id);
        delete ssh_conns[id];
        //we want to return connection error to caller, but error could fire after ready event is called. 
        //like timeout, or abnormal disconnect, etc..  need to prevent calling cb twice!
        if(cb) cb(err);
        cb = null;
    });

    exports.decrypt_resource(resource);
    //https://github.com/mscdex/ssh2#client-methods
    console.log("ssh_cons connecting ssh", id)
    conn.connect(Object.assign({
        host: hostname,
        username: resource.config.username,
        privateKey: resource.config.enc_ssh_private,

        //setting it longer for csiu
        keepaliveInterval: 10*1000, //default 0 (disabled)
        //keepaliveCountMax: 10, //default 3 (https://github.com/mscdex/ssh2/issues/367)

        readyTimeout: 1000*30, //default 20 seconds (https://github.com/mscdex/ssh2/issues/142) is too short?

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
            console.log("waiting sftp._count", sftp._count);
            return setTimeout(()=>{
                createReadStream(path, cb);
            }, 3000);
        }
        sftp._count++;
        console.debug("createReadStream sftp._count:", sftp._count);
        let stream = sftp.createReadStream(path);

        //10 minutes isn't enough for azure/vm to send output_fe.mat (1.2G) 
        //(todo). but output_fe.mat could be as big as 6G!
        let stream_timeout = setTimeout(()=>{
            console.error("readstream timeout.. force closing");
            stream.close();
        }, 1000*60*30); 

        stream.on('close', ()=>{
            clearTimeout(stream_timeout);
            //this gets fired if stream 'error' (due to missing path)
            //'ready' doesn't fire for stream
            //'finish' doesn't fire for stream
            sftp._count--;
            //console.debug("createreadstream closed _count:", sftp._count);
        });
        cb(null, stream);
    }

    function createWriteStream(path, cb) {
        //console.debug("createWriteStream", sftp._count);
        if(sftp._count > 4) {
            return setTimeout(()=>{
                createWriteStream(path, cb);
            }, 1000);
        }
        sftp._count++;
        let stream = sftp.createWriteStream(path);
        let stream_timeout = setTimeout(()=>{
            console.error("writestream timeout.. force closing");
            stream.close();
        }, 1000*60*30); 
        stream.on('close', ()=>{
            clearTimeout(stream_timeout);
            //console.debug("createwritestream refcount -1");
            sftp._count--;
        });
        cb(null, stream);
    }
    
    return { stat, readdir, createReadStream, createWriteStream, realpath };
}

//I need to keep up with sftp connection cache independent of ssh connection pool
//this returns reference counted sftp - similar to ssh connection queue
var sftp_conns = {};
exports.get_sftp_connection = function(resource, cb) {

    const hostname = resource.config.hostname;// || detail.hostname;
    const id = JSON.stringify({id: resource._id, hostname});
    
    //see if we already have an active sftp session
    var old = sftp_conns[id];
    if(old) {
        if(old.connecting) {
            console.debug("waiting for already connecting sftp .. %s", id);
            return setTimeout(()=>{
                exports.get_sftp_connection(resource, cb);
            }, 1000);
        }

        //if connection is too old, close it and open new one
        if(old._count == 0 && (new Date().getTime() - old.connected) > 1000*3600) {
            console.log("sftp connection is old.. opening new one %s", id);
            old.end();
        } else {
            console.debug("reusing sftp for resource %s", id);
            return cb(null, old);
        }
    }
    sftp_conns[id] = {connecting: true, create_date: new Date()};

    console.debug("opening new sftp connection");
    let connection_timeout = setTimeout(()=>{
        connection_timeout = null;
        console.log("ssh connection timeout...");
        if(cb) cb("ssh connection timeout");
        cb = null;
    }, 1000*30);

    const conn = new Client();
    conn.on('ready', function() {
        if(!connection_timeout) return; //already timed out
        clearTimeout(connection_timeout);

        console.debug("new ssh for sftp connection ready.. opening sftp:"+id);
        let t = setTimeout(()=>{
            console.error("got ssh connection but not sftp..");
            delete sftp_conns[id];
            if(cb) cb("got ssh connection but timedout while obtaining sftp:"+id);
            cb = null;
            t = null;
        }, 10*1000); //6sec too short for osgconnect
        conn.sftp((err, sftp)=>{
            if(!t) {
                console.error("it timed out while obtaining sftp connection.. should I close sftp connection?");
                return; //timed out already
            }
            clearTimeout(t);
            if(err) {
                console.error(err);
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
        console.debug("sftp connection ended %s", id);
        delete sftp_conns[id];
    });
    conn.on('close', function() {
        console.debug("sftp connection closed %s", id);
        delete sftp_conns[id];
    });
    conn.on('error', function(err) {
        if(!connection_timeout) return; //already timed out
        clearTimeout(connection_timeout);

        console.error("sftp connectionn error(%s) .. %s", err, id);
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
        readyTimeout: 1000*30, //default 20 seconds (https://github.com/mscdex/ssh2/issues/142) is too short?
        tryKeyboard: true, //needed by stampede2
    });
}

exports.report_ssh = function() {

    /*
    //dump oped ssh connection to troubleshoot high ssh connection
    console.debug("-- ssh report ----------------------");
    console.debug("connections:", Object.keys(ssh_conns).length);
    for(let k in ssh_conns) {
        const c = ssh_conns[k];
        console.debug(k, "created on", c.create_date, "connecting", c.connecting);
    }
    */
    console.log("debug-- dumping ssh_conns keys");
    console.dir(Object.keys(ssh_conns));
    console.log("debug-- dumping sftp_conns keys");
    console.dir(Object.keys(sftp_conns));
    
    return {
        ssh_cons: Object.keys(ssh_conns).length,
        sftp_cons: Object.keys(sftp_conns).length,
        //sftp_status, 
    }
}

/*
exports.get_user_gids = function(user) {
    const gids = user.gids||[];
    gids = gids.push(config.amaretti.globalGroup);
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
*/

//this function determines if user can use the resource on *some* resource
//this is not used to determine if the job can be submitted on this resource or not
//that's done by resource.js by looking up the task.gids
exports.canUseResource = function(user, resource) {
    const sub = user.sub.toString();

    //ownwer/admin can access the resource
    if(resource.user_id == sub) return true;
    if(resource.admins.includes[sub]) return true;

    //public resource can be used on any user/project
    if(resource.gids.includes(config.amaretti.globalGroup)) return true; 

    //find if user's gids intersects with gids specified in the resource
    let gidMatch = true;
    resource.gids.forEach(gid=>{
        if(user.gids.includes(gid)) gidMatch = true;
    });
    if(gidMatch) return true;

    return false;
}

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
                console.error("can't figure out instance status", instance._id.toString());
                console.error(JSON.stringify(counts, null, 4));
            }

            //let status_changed = false;
            //if(instance.status != newstatus) status_changed = true;
            
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

            //console.debug("updating instance status");
            //console.debug(JSON.stringify(instance.config, null, 4));

            let instance_o = instance.toObject();
            //instance_o._status_changed = status_changed;
            events.instance(instance_o);
        });
    });
}

exports.rerun_task = function(task, remove_date, cb) {
    switch(task.status) {
    //don't need to rerun non-terminated task
    case "running":
    case "running_sync":
    //don't know how I can rerun task that's stop_requested.. 
    case "stop_requested":
        return cb();
    }

    //don't rerun if task is already starting
    if(task.start_date && task.status == "requested") return cb();

    //don't rerun task that's locked
    if(task.locked) return cb("task is locked");

    //check to see if any deps tasks are running currently using this task.
    db.Task.findOne({ 
        "deps_config.task": task._id, 
        status: {$in: [ "requested", "running", "running_sync" ]} 
    }).countDocuments((err, count)=>{
        if(err) next(err);
        if(count > 0) {
            //TODO - rerunning task with active deps might not be always bad - if the tasks are in different resource.
            //let's not veto this completely.. I need to think more
            console.log("rerunning task with active deps - it might make the deps fail");
            //return cb("Can't rerun this task as it has dependent tasks that are currrently running.");
        }

        //all good! let's proceed with rerunning
        
        //let user reset remove_date, 
        if(remove_date) task.remove_date = remove_date;
        //or set it based on last relationship between request_date and remove_date
        else if(task.remove_date) {
            var diff = task.remove_date - task.request_date;
            if(diff < 0) {
                console.error("remove_date is before request_date.. unsetting remove_date..  this shouldn't happen but it does.. investigate");
                task.remove_date = undefined;
            } else {
                task.remove_date = new Date();
                task.remove_date.setTime(task.remove_date.getTime() + diff); 
                console.debug("reset remove_date", task.remove_date);
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


//search inside a list of mongoose ObjectID return position
exports.indexOfObjectId = function(ids, search_id, cb) {
    var pos = -1;
    ids.forEach((id,idx)=>{
        if(id.toString() == search_id.toString()) pos = idx;
    });
    return pos;
}

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

//wrapper for express-jwt to set some required default options
exports.jwt = opt=>{
    return jwt(Object.assign({
        secret: config.amaretti.auth_pubkey,
        algorithms: ['RS256'],
    }, opt));
}

