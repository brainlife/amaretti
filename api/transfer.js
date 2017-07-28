'use strict';

//contrib
const winston = require('winston');
const async = require('async');
const Client = require('ssh2').Client;
const sshagent = require('sshpk-agent');
const sshpk = require('sshpk');
//const timeout = require('callback-timeout');

//mine
const config = require('../config');
const logger = new winston.Logger(config.logger.winston);
const db = require('./models');
const common = require('../api/common');

logger.debug("using ssh_agent", process.env.SSH_AUTH_SOCK);
var sshagent_client = new sshagent.Client(); //uses SSH_AUTH_SOCK by default

exports.sshagent_list_keys = function(cb) {
    //logger.debug("listing keys from sshagent");
    //TODO sshagent-client throws (https://github.com/joyent/node-sshpk-agent/issues/11)
    sshagent_client.listKeys(cb);
    //sshagent_client.listKeys(timeout(cb, 3000));
}

//TODO I still haven't decided if I should make this a task that dynamically inserted between 2 dependent tasks at runtime.
//(or will that leads to possible infinite loop?)
//I think such approach is messy, and also think SCA should own the transfer routing / method decision. 
//Or.. we could do something like.. making a generic transfer task and SCA to figure out the best route / methods and pass
//that information via config.json?

function ssh_with_agent(resource, cb) {
    logger.debug("transfer: opening ssh connection to", resource.name);
    var detail = config.resources[resource.resource_id];
    var conn = new Client();
    var ready = false;
    conn.on('ready', function() {
        logger.debug("transfer: ssh connection ready");
        ready = true;
        cb(null, conn);
    });
    conn.on('end', function() {
        logger.debug("transfer: ssh connection ended");
    });
    conn.on('close', function() {
        logger.debug("transfer: ssh connection closed");
    });
    conn.on('error', function(err) {
        logger.error(err);
        if(!ready) cb(err);
    });

    logger.debug("transfer: decrypting dest (probly)");
    common.decrypt_resource(resource);
    conn.connect({
        host: resource.config.hostname || detail.hostname,
        username: resource.config.username,
        privateKey: resource.config.enc_ssh_private,
        keepaliveInterval: 60*1000, //defualt 0
        keepaliveCountMax: 10, //default 3
        agent: process.env.SSH_AUTH_SOCK,
        agentForward: true,
    });
}

exports.rsync_resource = function(source_resource, dest_resource, source_path, dest_path, cb, progress_cb) {
    ssh_with_agent(dest_resource, function(err, conn) {
        if(err) return cb(err); 
        async.series([
            /*
            function(next) {
                //install source key
                var key_filename = ".sca/keys/"+source_resource._id+".sshkey";
                //TODO - chmod *before* start copying!
                //TODO - better yet, pass the key via stream without storing on disk
                //TODO - or.. I could try using ssh2/forwardOut capability to create a tunnel between source_resource and dest_resource?
                conn.exec("cat > "+key_filename+" && chmod 600 "+key_filename, function(err, stream) {
                    if(err) next(err);
                    stream.on('close', function(code, signal) {
                        if(code) return next("Failed to write ssh key for source resource:"+souce_resource._id);
                        else next();
                    })
                    .on('data', function(data) {
                        logger.info(data.toString());
                    }).stderr.on('data', function(data) {
                        logger.error(data.toString());
                    });
                    common.decrypt_resource(source_resource);
                    var sshkey = new Buffer(source_resource.config.enc_ssh_private, 'utf8');
                    stream.write(sshkey);
                    stream.end();
                });
            },
            */
            next=>{
                //forward source's ssh key to dest
                //var privkey = sshpk.parsePrivateKey(fs.readFileSync("/home/hayashis/.ssh/id_rsa"), 'pem');
                logger.debug("transfer: decrypting source");
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
                conn.exec("mkdir -p "+dest_path, function(err, stream) {
                    if(err) next(err);
                    stream.on('close', function(code, signal) {
                        if(code) return next("Failed to mkdir -p "+dest_path);
                        else next();
                    })
                    .on('data', function(data) {
                        logger.info(data.toString());
                    }).stderr.on('data', function(data) {
                        logger.error(data.toString());
                    });
                });
            },  

            next=>{
                //run rsync  (pull from source)
                var source_resource_detail = config.resources[source_resource.resource_id];
                var hostname = source_resource.config.hostname || source_resource_detail.hostname;
                //TODO need to investigate why I need these -o options on q6>karst transfer
                //var sshopts = "ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -o PreferredAuthentications=publickey -i .sca/keys/"+source_resource._id+".sshkey";
                var sshopts = "ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -o PreferredAuthentications=publickey";
                var source = source_resource.config.username+"@"+hostname+":"+source_path+"/";
                //-v writes output to stderr.. even though it's not error..
                //-L is to follow symlinks (addtionally) --safe-links is desirable, but it will not transfer inter task/instance symlinks
                //-e opts is for ssh
                
                //I think this only works if the symlink exists on the root of the taskdir.. any symlinks under subdir is
                //still removed if same directory is rsynced as "inter" resource transfer (like karst>carbonate)
                //Right now, the only way to prevent symlink from being removed is to never share the same workdir among
                //various HPC clusters with shared file system
                //-K prevents destination symlink (if already existing) to be replaced by directory. this is needed for same-filesystem data transfer that has symlink

                logger.debug("rsync -a -L -e \""+sshopts+"\" "+source+" "+dest_path);
                conn.exec("rsync -a -L -e \""+sshopts+"\" "+source+" "+dest_path, function(err, stream) {
                    if(err) next(err);
                    stream.on('close', function(code, signal) {
                        if(code) next("Failed to rsync content from remove source:"+source+" to local dest:"+dest_path+" Please check firewall / sshd configuration / disk space");
                        else next();
                    }).on('data', function(data) {
                        //TODO rsync --progress output tons of stuff. I should parse / pick message to show and send to progress service
                        /*
                        logger.info(data.toString());
                        if(progress_cb) {
                            progress_cb({msg:data.toString()}); 
                        }
                        */
                    }).stderr.on('data', function(data) {
                        logger.error(data.toString());
                    });
                });
            },
        ], err=>{
            //I need to close ssh connection - since I am not using the ssh connection pool
            logger.debug("closing rsync ssh connection");
            conn.end();

            cb(err);
        });
    });
}

