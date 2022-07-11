'use strict';

//contrib
const winston = require('winston');
const async = require('async');
const sshpk = require('sshpk');
const ConnectionQueuer = require('ssh2-multiplexer');

//mine
const config = require('./config');
const db = require('./models');
const common = require('../api/common');

//execute cmd and call cb() with returned stdout content (if any)
function run_command(resource, cmd, next) {
    common.get_ssh_connection(resource, {}, (err, conn)=>{
        if(err) return next(err); 
        let stdout = "";
        let stderr = "";
        conn.exec(cmd, (err, stream)=>{
            if(err) return next(err);
            stream.on('close', (code, signal)=>{
                if(code === undefined) return next("timedout running "+cmd);
                else if(code) return next("code "+code+" running "+cmd);
                next(null, stdout, stderr);
            })
            .on('data', data=>{
                console.log(data.toString());
                stdout += data.toString();
            }).stderr.on('data', data=>{
                console.error(data.toString());
                stderr += data.toString();
            });
        });
    });
}

//all parameters must be safe
exports.rsync_resource = function(source_resource, dest_resource, source_path, dest_path, subdirs, progress_cb, cb) {
    //console.log("rsync_resource.. get_ssh_connection");

    let auth_sock;
    let agent;

    async.series([
        //make sure dest dir exists
        next=>{
            run_command(dest_resource, "timeout 20 mkdir -p "+dest_path, next);
            /*
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
                        console.log(data.toString());
                    }).stderr.on('data', data=>{
                        console.log(data.toString());
                    });
                });
            });
            */
        },  

        //make sure we aren't syncing between the same filesystem (like /N/project on IU resources)
        next=>{
            run_command(dest_resource, "stat -c %i "+dest_path, (err, dest_id)=>{
                if(err) return next(err);
                run_command(source_resource, "stat -c %i "+source_path, (err, source_id)=>{
                    if(err) return next(err);
                    console.debug("source_path", source_path, source_id);
                    console.debug("dest_path", dest_path, dest_id);
                    if(dest_id == source_id) {  
                        console.log("it *looks* like source filesytem is the same as dest filesytem.. skipping sync");
                        return cb(); //we are all done!
                    }
                    next();
                });
            });
        },

        //cleanup broken symlinks on source resource
        //also check for infinite loop
        next=>{
            //we are using rsync -L to derefernce symlink, which would fail if link is broken. so this is an ugly 
            //workaround for rsync not being forgivng..
            //console.log("finding and removing broken symlink on source resource before rsync", source_path);
            common.get_ssh_connection(source_resource, {}, (err, conn)=>{
                if(err) return next(err); 
                
                //https://unix.stackexchange.com/questions/34248/how-can-i-find-broken-symlinks
                //If Osiris mount is temporarily down, this ends up removing the symlinks and when osiris
                //comes back online, the staged path will remain removed. I wish there is a way to tell
                //rsync to only copy things that it can copy..
                conn.exec("timeout 30 find "+source_path+" -type l ! -exec test -e {} \\; -delete", (err, stream)=>{
                    if(err) return next(err);
                    stream.on('close', (code, signal)=>{
                        if(code === undefined) return next("connection closed while removing broken symlinks on source");
                        else if(code) return next("Failed to cleanup broken symlinks on source (or source is removed) code:"+code);

                        //https://serverfault.com/questions/265598/how-do-i-find-circular-symbolic-links
                        //only checking links as it's very slow..
                        conn.exec("timeout 30 find "+source_path+" -follow -type l -printf \"\"", (err, stream)=>{
                            if(err) return next(err);
                            stream.on('close', (code, signal)=>{
                                if(code === undefined) return next("connection closed while detecting infinite sym loop");
                                else if(code) return next("filesytem loop detected");
                                next();
                            })
                            .on('data', data=>{
                                console.log(data.toString());
                            }).stderr.on('data', data=>{
                                console.error(data.toString());
                            });
                        });
                    })
                    .on('data', data=>{
                        console.log(data.toString());
                    }).stderr.on('data', data=>{
                        console.error(data.toString());
                    });
                });
            });
        },  

        //run rsync!
        next=>{
            
            //run rsync (pull from source - use io_hostname if available)
            var source_resource_detail = config.resources[source_resource.resource_id];
            var source_hostname = source_resource.config.io_hostname || source_resource.config.hostname || source_resource_detail.hostname;
            
            //-o ConnectTimeout=120
            //TODO need to investigate why I need these -o options on q6>karst transfer
            //var sshopts = "ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -o PreferredAuthentications=publickey";
            //wranger can't rsync from tacc with PreferredAuthentications=publickey
            var sshopts = "ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no";
            var source = source_resource.config.username+"@"+source_hostname+":"+source_path+"/";
            
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
            var dest_hostname = dest_resource.config.io_hostname||dest_resource.config.hostname||dest_resource_detail.hostname;
            //console.log("ssh to %s", dest_hostname);

            //include/exclude options - by default, copy everything except .*
            //let's not copy config.json as it could contains sensitive info 
            //(like.. token/secret for xnat in app-stage!!)
            var inexopts = "--exclude=\".*\" --exclude=config.json";
            if(subdirs && subdirs.length) {
                inexopts = "";
                subdirs.forEach(dir=>{
                    if(dir.indexOf("include:") == 0) {
                        //because of rsync oddness, I need to enumerate all parent directories separately.
                        //https://stackoverflow.com/a/26790074/99330
                        const fullpath = dir.substring(8);
                        const tokens = fullpath.split("/");
                        let part = "";
                        tokens.forEach(token=>{
                            part += token;
                            inexopts += "--include=\""+part+"\" ";
                            part += "/";
                        });
                        inexopts += "--include=\""+part+"***\" "; //need the last one with ***
                    } else {
                        //subdir method is simple..
                        inexopts += "--include=\""+dir+"/***\" ";
                    }
                });
                inexopts += "--exclude=\"*\" "; //without this at the end, include doesn't work
            }

            //work around for ratar mount not able to handle hardlinks
            //https://github.com/mxmlnkn/ratarmount/issues/28
            //TODO

            //setup sshagent with the source key
            common.decrypt_resource(source_resource);
            var privkey = sshpk.parsePrivateKey(source_resource.config.enc_ssh_private, 'pem');
            common.create_sshagent(privkey, (err, agent, client, auth_sock)=>{
                if(err) return next(err);
                common.get_ssh_connection(dest_resource, {
                    hostname: dest_hostname,
                    agent: auth_sock,
                    agentForward: true,
                }, (err, conn)=>{
                    if(err) return next(err); 
                    //adding timeout 630 will somehow break data.bridges2.psc.edu (code 1)
                    let cmd = "rsync --timeout 600 "+inexopts+" --progress -h -a -L --no-g -e \""+sshopts+"\" "+source+" "+dest_path;
                    conn.exec(cmd, (err, stream)=>{
                        if(err) {
                            console.error(err);
                            agent.kill();
                            conn.end();
                            return next(err);
                        }
                        let errors = "";
                        let progress_date = new Date();
                        let first = true;

                        stream.on('close', (code, signal)=>{
                            //console.debug("stream closed.....................");

                            agent.kill(); //I could call agnet.kill as soon as rsync starts, but agent doesn't die until rsync finishes..
                            conn.end(); //need to create new ssh connection each time.. 

                            if(code === undefined) return next("timedout while rsyncing");
                            else if(code) { 
                                errors += "rsync exit code:"+code+"\n";
                                console.error("On dest resource:"+dest_hostname+" < Failed to rsync content from source:"+source+" to local path:"+dest_path+" code:"+code);
                                console.error(cmd);
                                //console.error(errors);
                                next(errors);
                            } else {
                                console.info("done! %d:%d", code, signal);
                                next();
                            }
                        }).on('data', data=>{
                            if(first) {
                                //console.debug("removing key");
                                client.removeAllKeys({}, err=>{
                                    if(err) console.error(err);
                                });
                                first = false;
                            }

                            let str = data.toString().trim();
                            if(str == "") return;
                             
                            //send progress report every few seconds 
                            let now = new Date();
                            let delta = now.getTime() - progress_date.getTime();
                            if(delta > 1000*5) {
                                progress_cb(str);
                                progress_date = now;
                                console.debug(str);
                            } 
                        }).stderr.on('data', data=>{
                            errors += data.toString();
                            console.debug(data.toString());
                        });
                    });
                });
            });
        },
    ], cb);
}

