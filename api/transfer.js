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

exports.rsync_resource = function(source_resource, dest_resource, source_path, dest_path, progress_cb, cb) {
    logger.info("rsync_resource.. get_ssh_connection");

    let auth_sock;
    let agent;

    async.series([
        //make sure dest dir exists
        next=>{
            common.get_ssh_connection(dest_resource, {}, (err, conn)=>{
                if(err) return next(err); 
                conn.exec("timeout 20 mkdir -p "+dest_path, (err, stream)=>{
                    if(err) return next(err);
                    stream.on('close', (code, signal)=>{
                        if(code === undefined) return next("timedout while mkdir -p "+dest_path);
                        else if(code) return next("Failed to mkdir -p "+dest_path);
                        next();
                    })
                    .on('data', data=>{
                        logger.info(data.toString());
                    }).stderr.on('data', data=>{
                        logger.warn(data.toString());
                    });
                });
            });
        },  

        //cleanup broken symlinks on source resource
        next=>{
            //we are using rsync -L to derefernce symlink, which would fail if link is broken. so this is an ugly 
            //workaround for rsync not being forgivng..
            //TODO - why not directly access the source?
            logger.info("finding and removing broken symlink on source resource before rsync");
            common.get_ssh_connection(source_resource, {}, (err, conn)=>{
                if(err) return next(err); 
                conn.exec("timeout 30 find -L "+source_path+" -type l -delete", (err, stream)=>{
                    if(err) return next(err);
                    stream.on('close', (code, signal)=>{
                        if(code === undefined) return next("timedout while removing broken symlinks on source");
                        else if(code) return next("Failed to cleanup broken symlinks on source (or source is removed) code:"+code);
                        next();
                    })
                    .on('data', data=>{
                        logger.info(data.toString());
                    }).stderr.on('data', data=>{
                        logger.warn(data.toString());
                    });
                });
            });
        },  

        //run rsync!
        next=>{
            
            //run rsync (pull from source - use io_hostname if available)
            var source_resource_detail = config.resources[source_resource.resource_id];
            var hostname = source_resource.config.io_hostname || source_resource.config.hostname || source_resource_detail.hostname;
            
            //-o ConnectTimeout=120
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
            //--info-progress2 is only available for newer rsync..
            //can't use timeout command as this might get executed on io only node
            //we need to use dest_resource's io_hostname if available
            var dest_resource_detail = config.resources[dest_resource.resource_id];
            var hostname = dest_resource.config.io_hostname||dest_resource.config.hostname||dest_resource_detail.hostname;
            logger.debug("ssh to %s", hostname);

            //setup sshagent with the source key
            common.decrypt_resource(source_resource);
            var privkey = sshpk.parsePrivateKey(source_resource.config.enc_ssh_private, 'pem');
            common.create_sshagent(privkey, (err, agent, auth_sock)=>{
                if(err) next(err);
                common.get_ssh_connection(dest_resource, {
                    hostname,
                    agent: auth_sock,
                    agentForward: true,
                }, (err, conn)=>{
                    if(err) return next(err); 
                    logger.debug("rsync --timeout 600 --progress -h -a -L -e \""+sshopts+"\" "+source+" "+dest_path);
                    conn.exec("rsync --timeout 600 --exclude \".*\" --progress -h -a -L -e \""+sshopts+"\" "+source+" "+dest_path, (err, stream)=>{
                        if(err) return next(err);
                        let errors = "";
                        let progress_date = new Date();
                        stream.on('close', (code, signal)=>{

                            //TODO - instead of waiting for rsync to terminate, I think I can kill it as soon as transfer starts.
                            //I don't know how to detect that though.. maybe look for a certain token in the log?
                            agent.kill(); //no longer needed..
                            conn.end(); //need to create new ssh connection each time.. 

                            if(code === undefined) return next("timedout while rsyncing");
                            else if(code) { 
                                logger.error("On resource:"+hostname+" < Failed to rsync content from source:"+source+" to local path:"+dest_path+" code:"+code);
                                logger.error(errors);
                                next(errors);
                            } else {
                                logger.info("done! %d:%d", code, signal);
                                next();
                            }
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
                            //logger.debug(data.toString());
                        }).stderr.on('data', data=>{
                            errors += data.toString();
                            logger.debug(data.toString());
                        });
                    });
                });
            });
        },
    ], cb);
}

