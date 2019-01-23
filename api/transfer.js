'use strict';

//contrib
const winston = require('winston');
const async = require('async');
const Client = require('ssh2').Client;
const sshpk = require('sshpk');
const ConnectionQueuer = require('ssh2-multiplexer');

//mine
const config = require('../config');
const logger = winston.createLogger(config.logger.winston);
const db = require('./models');
const common = require('../api/common');

/*
//very similar to the one in api/common, but I don't want to mix it with non-agennt enabled one for security reason
function get_ssh_connection_with_agent(resource, cb) {
    logger.debug("transfer: opening ssh connection to", resource._id.toString());
    var conn = new Client();
    conn.on('ready', function() {
        logger.debug("transfer: ssh connection ready", resource._id.toString());
        if(cb) cb(null, conn); //success!
        cb = null;
    });
    conn.on('end', function() {
        logger.debug("transfer: ssh connection ended", resource._id.toString());
    });
    conn.on('close', function() {
        logger.debug("transfer: ssh connection closed", resource._id.toString());
    });
    conn.on('error', function(err) {
        logger.error("transfer: ssh connectionn error", err, resource._id.toString());
        if(cb) cb(err);
        cb = null;
    });

    common.decrypt_resource(resource);
    let detail = config.resources[resource.resource_id];
    conn.connect({
        host: resource.config.hostname || detail.hostname,
        username: resource.config.username,
        privateKey: resource.config.enc_ssh_private,
        keepaliveInterval: 10*1000, //default 0 (disabled) - I need to keep it alive because I am caching

        //TODO - increasing readyTimeout doesn't seem to fix "Error: Timed out while waiting for handshake"
        //I think I should re-try connecting instead?
        //readyTimeout: 1000*30, //default 20 seconds (https://github.com/mscdex/ssh2/issues/142)

        //we use agent to allow transfer between 2 remote resources
        agent: process.env.SSH_AUTH_SOCK,
        agentForward: true,
    });
}
*/

/*
3|task     | 0> Sun Mar 25 2018 11:53:14 GMT+0000 (UTC) - error: failed rsyncing......... { Error: (SSH) Channel open failure: open failed
3|task     |     at SSH2Stream.onFailure (/app/node_modules/ssh2/lib/client.js:1195:13)
3|task     |     at Object.onceWrapper (events.js:315:30)
3|task     |     at emitOne (events.js:116:13)
3|task     |     at SSH2Stream.emit (events.js:211:7)
3|task     |     at parsePacket (/app/node_modules/ssh2-streams/lib/ssh.js:3708:10)
3|task     |     at SSH2Stream._transform (/app/node_modules/ssh2-streams/lib/ssh.js:669:13)
3|task     |     at SSH2Stream.Transform._read (_stream_transform.js:186:10)
3|task     |     at SSH2Stream._read (/app/node_modules/ssh2-streams/lib/ssh.js:251:15)
3|task     |     at SSH2Stream.Transform._write (_stream_transform.js:174:12)
3|task     |     at doWrite (_stream_writable.js:397:12)
3|task     |     at writeOrBuffer (_stream_writable.js:383:5)
3|task     |     at SSH2Stream.Writable.write (_stream_writable.js:290:11)
3|task     |     at Socket.ondata (_stream_readable.js:639:20)
3|task     |     at emitOne (events.js:116:13)
3|task     |     at Socket.emit (events.js:211:7)
3|task     |     at addChunk (_stream_readable.js:263:12) reason: 'ADMINISTRATIVELY_PROHIBITED', lang: '' } 5ab7211312aa03002bf955cd
*/

exports.rsync_resource = function(source_resource, dest_resource, source_path, dest_path, progress_cb, cb) {
    //logger.debug("rsync_resource", source_resource._id, dest_resource._id, source_path, dest_path);
    common.get_ssh_connection(dest_resource, {
        agent: process.env.SSH_AUTH_SOCK,
        agentForward: true,
    }, function(err, conn) {
        if(err) return cb(err); 
        logger.debug("got ssh conn");

        let rsync_conn;

        async.series([
            next=>{
                //forward source's ssh key to dest
                //var privkey = sshpk.parsePrivateKey(fs.readFileSync("/home/hayashis/.ssh/id_rsa"), 'pem');
                common.decrypt_resource(source_resource);
                var privkey = sshpk.parsePrivateKey(source_resource.config.enc_ssh_private, 'pem');

                //this throws if ssh agent isn't running, but try/catch won't catch.. 
                //https://github.com/joyent/node-sshpk-agent/issues/11
                //"expires" in seconds (10 seconds seems to be too short..)
                //TODO - I am not sure if 60 seconds is enough, or that extending it would fix the problem.
                //    [rsync]
                //    Permission denied (publickey).
                //    sync: connection unexpectedly closed (0 bytes received so far) [receiver]
                common.sshagent_add_key(privkey, {expires: 60}, next); 
            },

            next=>{
                //make sure dest dir exists
                //TODO - set timeout similar to bin/task's?
                conn.exec("timeout 20 mkdir -p "+dest_path, function(err, stream) {
                    if(err) return next(err);
                    //common.set_conn_timeout(conn, stream, 1000*20);
                    stream.on('close', function(code, signal) {
                        if(code === undefined) return next("timedout while mkdir -p "+dest_path);
                        else if(code) return next("Failed to mkdir -p "+dest_path);
                        next();
                    })
                    .on('data', function(data) {
                        logger.info(data.toString());
                    }).stderr.on('data', function(data) {
                        logger.error(data.toString());
                    });
                });
            },  

            next=>{
                //cleanup broken symlinks on source resource
                //we are using rsync -L to derefernce symlink, which would fail if link is broken. so this is an ugly 
                //workaround for rsync not being forgivng..
                logger.debug("finding and removing broken symlink on source resource before rsync");
                var hostname = source_resource.config.hostname || source_resource_detail.hostname; 
                conn.exec("timeout 30 ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -o PreferredAuthentications=publickey "+source_resource.config.username+"@"+hostname+" find -L "+source_path+" -type l -delete", (err, stream)=> {
                    if(err) return next(err);
                    stream.on('close', function(code, signal) {
                        if(code === undefined) return next("timedout while removing broken symlinks");
                        else if(code) return next("Failed to cleanup broken symlinks on source (or source is removed) code:"+code);
                        next();
                    })
                    .on('data', function(data) {
                        logger.info(data.toString());
                    }).stderr.on('data', function(data) {
                        logger.warn(data.toString());
                    });
                });
            },  

            //open ssh connection on io_hostname so that we can run rsync from it
            next=>{
                if(!dest_resource.config.io_hostname) {
                    rsync_conn = conn;
                    return next();
                }
                common.get_ssh_connection(dest_resource, {
                    hostname: dest_resource.config.io_hostname,
                    agent: process.env.SSH_AUTH_SOCK,
                    agentForward: true,
                }, function(err, io_conn) {
                    if(err) return cb(err); 
                    logger.debug("created io connection with %s", dest_resource.config.io_hostname);
                    rsync_conn = io_conn;
                    next();
                });
            },

            //run rsync!
            next=>{
                //run rsync (pull from source - use io_hostname if available)
                var source_resource_detail = config.resources[source_resource.resource_id];
                var hostname = source_resource.config.io_hostname || source_resource.config.hostname || source_resource_detail.hostname;
                
                //TODO need to investigate why I need these -o options on q6>karst transfer
                var sshopts = "ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -o PreferredAuthentications=publickey";

                var source = source_resource.config.username+"@"+hostname+":"+source_path+"/";
                
                //-v writes output to stderr.. even though it's not error..
                //-L is to follow symlinks (addtionally) --safe-links is desirable, but it will not transfer inter task/instance symlinks
                //-e opts is for ssh
                //-h is to make it human readable
                
                //I think this only works if the symlink exists on the root of the taskdir.. any symlinks under subdir is
                //still removed if same directory is rsynced as "inter" resource transfer (like karst>carbonate)
                //Right now, the only way to prevent symlink from being removed is to never share the same workdir among
                //various HPC clusters with shared file system
                //-K prevents destination symlink (if already existing) to be replaced by directory. 
                //this is needed for same-filesystem data transfer that has symlink
                logger.debug("running rsync -a -L -e \""+sshopts+"\" "+source+" "+dest_path);

                //--info-progress2 is only available for newer rsync..
                //can't use timeout command as this might get executed on io only node
                rsync_conn.exec("rsync --timeout 600 --progress -h -a -L -e \""+sshopts+"\" "+source+" "+dest_path, function(err, stream) {
                    if(err) return next(err);
                    //common.set_conn_timeout(conn, stream, 1000*60*5); //5 minutes 
                    let errors = "";
                    let progress_date = new Date();
                    stream.on('close', function(code, signal) {
                        if(code === undefined) return next("timedout while rsyncing");
                        else if(code) { 
                            logger.error("Failed to rsync content from remote resource:"+source+" to local path:"+dest_path+" code:"+code);
                            logger.error(errors);
                            next(errors);
                        } else next();
                    }).on('data', data=>{
                        let str = data.toString().trim();
                        if(str == "") return;
                        
                        //send progress report every few seconds 
                        let now = new Date();
                        let delta = now.getTime() - progress_date.getTime();
                        if(delta > 1000*5) {
                            progress_cb(str);
                            progress_date = now;
                            logger.debug(str);
                        } 
                    }).stderr.on('data', data=>{
                        //logger.error(data.toString());
                        errors += data.toString();
                    });
                });
            },

        ], err=>{
            //conn.end();
            cb(err);
        });
    });
}

