'use strict';

//contrib
const winston = require('winston');
const async = require('async');
const Client = require('ssh2').Client;
const sshagent = require('sshpk-agent');
const sshpk = require('sshpk');
const ConnectionQueuer = require('ssh2-multiplexer');

//mine
const config = require('../config');
const logger = new winston.Logger(config.logger.winston);
const db = require('./models');
const common = require('../api/common');

logger.debug("using ssh_agent", process.env.SSH_AUTH_SOCK);
var sshagent_client = new sshagent.Client(); //uses SSH_AUTH_SOCK by default

exports.sshagent_list_keys = function(cb) {
    //TODO sshagent-client throws (https://github.com/joyent/node-sshpk-agent/issues/11)
    sshagent_client.listKeys(cb);
}

//very similar to the one in api/common, but I don't want to fix it with non-agennt enabled one for security reason
var ssh_conns = {};
function get_ssh_connection_with_agent(resource, cb) {
    //see if we already have an active ssh session
    var old = ssh_conns[resource._id];
    //TODO - check to make sure connection is really alive?
    if(old) return cb(null, old);

    logger.debug("transfer: opening ssh connection to", resource.name);
    var detail = config.resources[resource.resource_id];
    var conn = new Client();
    conn.on('ready', function() {
        logger.debug("transfer: ssh connection ready");
        var connq = new ConnectionQueuer(conn);
        ssh_conns[resource._id] = connq;

        if(cb) cb(null, connq); //success!
        cb = null;
    });
    conn.on('end', function() {
        logger.debug("transfer: ssh connection ended");
        delete ssh_conns[resource._id];
    });
    conn.on('close', function() {
        logger.debug("transfer: ssh connection closed");
        delete ssh_conns[resource._id];
    });
    conn.on('error', function(err) {
        logger.error("transfer: ssh connectionn error", err, resource._id.toString());
        delete ssh_conns[resource._id];
       
        //error could fire after ready event is called. like timeout, or abnormal disconnect, etc..  need to prevent calling cb twice!
        if(cb) cb(err);
        cb = null;
    });

    common.decrypt_resource(resource);
    //https://github.com/mscdex/ssh2#client-methods
    conn.connect({
        host: resource.config.hostname || detail.hostname,
        username: resource.config.username,
        privateKey: resource.config.enc_ssh_private,
        
        //I shouldn't need keepalive for rsync
        //keepaliveInterval: 60*1000, //defualt 0
        //keepaliveCountMax: 10, //default 3

        //TODO - increasing readyTimeout doesn't seem to fix "Error: Timed out while waiting for handshake"
        //I think I should re-try connecting instead?
        //readyTimeout: 1000*30, //default 20 seconds (https://github.com/mscdex/ssh2/issues/142)

        //we use agent to allow transfer between 2 remote resources
        agent: process.env.SSH_AUTH_SOCK,
        agentForward: true,
    });
}

exports.rsync_resource = function(source_resource, dest_resource, source_path, dest_path, cb) {
    //logger.debug("rsync_resource", source_resource._id, dest_resource._id, source_path, dest_path);
    get_ssh_connection_with_agent(dest_resource, function(err, conn) {
        if(err) return cb(err); 
        async.series([
            next=>{
                //forward source's ssh key to dest
                //var privkey = sshpk.parsePrivateKey(fs.readFileSync("/home/hayashis/.ssh/id_rsa"), 'pem');
                //logger.debug("transfer: decrypting source");
                common.decrypt_resource(source_resource);
                var privkey = sshpk.parsePrivateKey(source_resource.config.enc_ssh_private, 'pem');

                //this throws if ssh agent isn't running, but try/catch won't catch.. 
                //https://github.com/joyent/node-sshpk-agent/issues/11
                //"expires" in seconds (10 seconds seems to be too short..)
                //TODO - I am not sure if 60 seconds is enough, or that extending it would fix the problem.
                //    [rsync]
                //    Permission denied (publickey).
                //    sync: connection unexpectedly closed (0 bytes received so far) [receiver]
                sshagent_client.addKey(privkey, {expires: 60}, next); 
            },

            next=>{
                //make sure dest dir exists
                //TODO - set timeout similar to bin/task's?
                conn.exec("mkdir -p "+dest_path, function(err, stream) {
                    if(err) return next(err);
                    stream.on('close', function(code, signal) {
                        if(code) return next("Failed to mkdir -p "+dest_path);
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
                //run rsync (pull from source)
                var source_resource_detail = config.resources[source_resource.resource_id];
                var hostname = source_resource.config.hostname || source_resource_detail.hostname;
                //TODO need to investigate why I need these -o options on q6>karst transfer
                var sshopts = "ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -o PreferredAuthentications=publickey";
                var source = source_resource.config.username+"@"+hostname+":"+source_path+"/";
                //-v writes output to stderr.. even though it's not error..
                //-L is to follow symlinks (addtionally) --safe-links is desirable, but it will not transfer inter task/instance symlinks
                //-e opts is for ssh
                
                //I think this only works if the symlink exists on the root of the taskdir.. any symlinks under subdir is
                //still removed if same directory is rsynced as "inter" resource transfer (like karst>carbonate)
                //Right now, the only way to prevent symlink from being removed is to never share the same workdir among
                //various HPC clusters with shared file system
                //-K prevents destination symlink (if already existing) to be replaced by directory. 
                //this is needed for same-filesystem data transfer that has symlink
                logger.debug("running rsync -a -L -e \""+sshopts+"\" "+source+" "+dest_path);

                //TODO set timeout similar to bin/task?
                conn.exec("rsync -a -L -e \""+sshopts+"\" "+source+" "+dest_path, function(err, stream) {
                    if(err) return next(err);
                    let errors = "";
                    stream.on('close', function(code, signal) {
                        if(code) { 
                            //next("Failed to rsync content from remote resource:"+source+" to local path:"+dest_path+" -- "+errors);
                            logger.error("Failed to rsync content from remote resource:"+source+" to local path:"+dest_path+" -- "+errors);
                            //" Please check firewall / sshd configuration / disk space / resource availability");
                            next(errors);
                        } else next();
                    }).on('data', function(data) {
                        //TODO rsync --progress output tons of stuff. I should parse / pick message to show and send to progress service
                        logger.debug(data.toString());
                    }).stderr.on('data', function(data) {
                        //logger.error(data.toString());
                        errors += data.toString();
                    });
                });
            },
        ], cb);
    });
}

