'use strict';

//node
var fs = require('fs');

//contrib
var express = require('express');
var router = express.Router();
var winston = require('winston');
var jwt = require('express-jwt');
var async = require('async');
var path = require('path');
var multiparty = require('multiparty');
var mime = require('mime');
var modeString = require('fs-mode-to-string');

//mine
var config = require('../../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models/db');
var common = require('../common');
var resource_picker = require('../resource_picker');
var transfer = require('../transfer');

function mask_enc(resource) {
    //mask all config parameters that starts with enc_
    for(var k in resource.config) {
        if(k.indexOf("enc_") === 0) {
            resource.config[k] = true;
        }
    }
    return resource;
}

//return all resource detail that belongs to the user
router.get('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    db.Resource.find({
        user_id: req.user.sub
    })
    .lean()
    .exec(function(err, resources) {
        if(err) return next(err);
        resources.forEach(mask_enc);
            
        //add / remove a few more things
        resources.forEach(function(resource) {
            resource.detail = config.resources[resource.resource_id];
            //resource.workdir = common.getworkdir(null, resource); //nobody uses this at the moment
            resource.salts = undefined;
            resource.user_id = undefined; //no point
        });
        res.json(resources);
    });
});

//use sftp/readir to list file entries
router.get('/ls', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var resource_id = req.query.resource_id;
    var _path = req.query.path; //TODO.. validate?
    db.Resource.findById(resource_id, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).json({message: "couldn't find the resource specified"});
        if(resource.user_id != req.user.sub) return res.status(401).end(); 

        //append workdir if relateive
        if(_path[0] != "/") _path = common.getworkdir(_path, resource);

        logger.debug("getting ssh connection");
        common.get_ssh_connection(resource, function(err, conn) {
            logger.debug("got something..");
            if(err) return next(err);
            logger.debug("starting sftp session..");
            conn.sftp(function(err, sftp) {     
                if(err) return next(err);
                logger.debug("reading directory:"+_path);
                sftp.readdir(_path, function(err, files) {
                    sftp.end();
                    if(err) return next(err);
                    files.forEach(function(file) {
                        file.attrs.mode_string = modeString(file.attrs.mode);
                    });
                    res.json({files: files});
                });
            }); 
        });
    });
});

//return a best resource for a given purpose / criteria (TODO..)
//TODO ..only sca service should be responsible for picking the best resource.., and dealing with decrypted config
//currently used by file upload service to pick which resource to upload files to
router.get('/best', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    resource_picker.select(req.user.sub, {
        service_id: req.query.service_id,  //service_id that resource must provide
        other_service_id: req.query.other_service_ids, //TODO -- helps to pick a better ID
    }, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end();
        var resource_detail = config.resources[resource.resource_id];
        var ret = {
            resource: resource,
            detail: resource_detail,
            workdir: common.getworkdir(null, resource),
        };
        res.json(ret);
    });
});

function mkdirp(conn, dir, cb) {
    //var dir = path.dirname(_path);
    //logger.debug("mkdir -p "+dir);
    conn.exec("mkdir -p "+dir, {}, function(err, stream) {
        if(err) return cb(err);
        stream.on('close', function(code, signal) {
            logger.log("mkdir -p done");
            cb();
        });
    });
}

//handle file upload request via multipart form
//takes resource_id and path via headers
router.post('/upload', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var form = new multiparty.Form({autoFields: true});
    //var resource_id = req.headers.resource_id;
    //var _path = req.headers.path;

    var fields = {};
    form.on('field', function(name, value) {
        //TODO validate?
        fields[name] = value;
        console.log("got field:"+name+" "+value);
    });

    form.on('part', function(part) {
        if(!fields.resource_id || !fields.path) return next("resource_id or path parameters missing");
        part.on('error', next);

        //part is received.. find resource
        db.Resource.findById(fields.resource_id, function(err, resource) {
            if(err) return next(err);
            if(!resource) return res.status(404).json({message: "couldn't find the resource specified"});
            if(resource.user_id != req.user.sub) return res.status(401).end(); 
            common.get_ssh_connection(resource, function(err, conn) {
                if(err) return next(err);
                //logger.debug("calling mkdirp");
                mkdirp(conn, fields.path, function(err) {
                    if(err) return next(err);
                    conn.sftp(function(err, sftp) {
                        if(err) return next(err);
                        //create directory.. (in case it doesn't exist yet.. TODO - this is not recursive)
                        //sftp.mkdir(fields.path, function(err) {
                        //    if(err) logger.error(err); //continue
                        var escaped_filename = part.filename.replace(/"/g, '\\"');
                        var _path = fields.path+"/"+escaped_filename;
                        var stream = sftp.createWriteStream(_path);
                        logger.debug("streaming file");
                        part.pipe(stream).on('close', function() {
                            logger.debug("streaming closed");
                            sftp.stat(_path, function(err, stat) {
                                sftp.end();
                                if(err) return next(err);
                                res.json({file: {filename: part.filename, attrs: stat}});
                            });
                        });
                        //}); 
                    });
                });
                /*
                form.on('close', function() {
                    res.json({message: "ok"});
                });
                */
                
                /*
                //often form parsing ends before ssh streaming finishes..
                //we need to avoid moving on before all ssh-streaming completes (or partial file will be left)
                var open_streams = 0;
                function alldone() {
                    if(open_streams == 0) {
                        //all done
                        res.json({message: "files uploaded", file: file});
                    } else {
                        //I need to wait for all stream to close before moving on..
                        logger.info("waiting for streams to close (remaining:"+open_streams+")");
                        setTimeout(alldone, 1000);
                    }
                };
                form.on('close', alldone);

                logger.info("ssh open");
                //stream file to remote system
                var escaped_filename = part.filename.replace(/"/g, '\\"');
                //TODO - let's just overwrite files if it already exists..
                //in the future, I should either fail, or upload to an alternative filename
                conn.exec("mkdir -p "+fields.path+" && cat >\""+fields.path+"/"+escaped_filename+"\"", {}, function(err, stream) {
                    if(err) return next(err);
                    open_streams++;
                    stream.on('exit', function() {
                        logger.debug("stream exited");
                        open_streams--;
                    });
                    logger.debug("pipping part:"+part.filename+" to ssh stream");
                    part.pipe(stream);
                });
                */
            });
        });
    });
    form.parse(req);
});

/* I believe noone uses this 
router.post('/exec', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var resource_id = req.body.resource_id;
    var cmd = req.body.cmd;
    db.Resource.findById(resource_id, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).json({message: "couldn't find the resource specified"});
        if(resource.user_id != req.user.sub) return res.status(401).end(); 
        common.get_ssh_connection(resource, function(err, conn) {
            if(err) return next (err);
            var workdir = common.getworkdir("", resource);
            conn.exec("cd "+workdir+" && "+cmd, function(err, stream) {
                if(err) return cb(err);
                stream.on('data', function(data) {
                    res.write(data);
                });
                stream.on('end', function(data) {
                    res.end();
                    //conn.end();
                });
            });
        });
    });
});
*/

router.post('/transfer', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var task_id = req.body.task_id;
    var dest_resource_id = req.body.dest_resource_id;

    db.Task.findById(task_id, function(err, task) {
        if(err) return next(err);
        if(!task) return res.status(404).json({message: "couldn't find the task specified"});
        if(task.user_id != req.user.sub) return res.status(401).end(); 
        db.Resource.findById(task.resource_id, function(err, source_resource) {
            if(err) return next(err);
            //if(!source_resource) return res.status(404).json({message: "couldn't find the source resource specified in a task"});
            //if(source_resource.user_id != req.user.sub) return res.status(401).end(); 
            db.Resource.findById(dest_resource_id, function(err, dest_resource) {
                if(err) return next(err);
                if(!dest_resource) return res.status(404).json({message: "couldn't find the dest resource specified"});
                if(dest_resource.user_id != req.user.sub) return res.status(401).end(); 

                var source_path = common.gettaskdir(task.instance_id, task_id, source_resource);
                var dest_path = common.gettaskdir(task.instance_id, task_id, dest_resource);

                //now start rsync
                transfer.rsync_resource(source_resource, dest_resource, source_path, dest_path, function(err) {
                    if(err) throw err; //TODO - don't throw here.. mark this transfer as failed (no such collection yet)
                });
                res.json({message: "data transfer requested.."});
            });
        });
    });
});

//this API allows user to download any files under user's workflow directory
//TODO - since I can't let <a> pass jwt token via header, I have to expose it via URL.
//doing so increases the chance of user misusing the token, but unless I use HTML5 File API
//there isn't a good way to let user download files..
//getToken() below allows me to check jwt token via "at" query.
router.get('/download', jwt({
    secret: config.sca.auth_pubkey,
    getToken: function fromHeaderOrQuerystring (req) { return req.query.at; }
}), function(req, res, next) {
    var resource_id = req.query.r;
    var _path = req.query.p;
    
    //TODO - this validation isn't good enough.. (use can use escape, etc..)
    //if(~_path.indexOf("..")) return next("invalid path");

    db.Resource.findById(resource_id, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).json({message: "couldn't find the resource specified"});
        if(resource.user_id != req.user.sub) return res.status(401).end(); 
        
        //append workdir if relateive
        if(_path[0] != "/") _path = common.getworkdir(_path, resource);
        logger.debug("downloading: "+_path);
        logger.debug("from resource:"+resource._id);

        common.get_ssh_connection(resource, function(err, conn) {
            if(err) return next(err);
            conn.sftp(function(err, sftp) {
                if(err) return next(err);
                sftp.stat(_path, function(err, stat) {
                    if(err) return next(err);
                    console.log(mime.lookup(_path));
                    //res.setHeader('Content-disposition', 'attachment; filename='+path.basename(_path));
                    res.setHeader('Content-disposition', 'filename='+path.basename(_path));
                    res.setHeader('Content-Length', stat.size);
                    res.setHeader('Content-Type', mime.lookup(_path));
                    var stream = sftp.createReadStream(_path);
                    stream.pipe(res);               
                    /*
                    stream.on('end', function() {
                        logger.debug("download streaming ended");
                    });
                    */
                });
            });
        });
    });
});

/*
//stream file content via ssh using cat..  through sca web server
//TODO - I need to use something like data service - except that it does the fetching of data through resource information
//TODO - should I use ssh2/sftp?
function download_file(resource, _path, res, cb) {
    common.get_ssh_connection(resource, function(err, conn) {
        if(err) return cb(err);
        //get filesize first (TODO - do this only if file.size isn't set)
        console.log("stat --printf=%s "+_path);
        var workdir = common.getworkdir("", resource);
        _path = workdir + "/"+_path;
        conn.exec("stat --printf=%s "+_path, function(err, stream) {
            if(err) return cb(err);
            var size = "";
            stream.on('data', function(data) {
                size += data;
            });
            stream.on('close', function() {
                //report file size/type
                var filename = path.basename(_path);
                res.setHeader('Content-disposition', 'attachment; filename='+filename);
                console.log("file size:"+size.toString());
                //res.setHeader('Content-Length', size);
                //if(file.size) res.setHeader('Content-Length', file.size);
                //if(file.type) res.setHeader('Content-type', file.type);
                //now stream
                var escaped_path = _path.replace(/"/g, '\\"');
                conn.exec("cat \""+escaped_path+"\"", function(err, stream) {
                    if(err) return cb(err);
                    stream.on('data', function(data) {
                        res.write(data);
                    });
                    stream.on('end', function() {
                        res.end();
                    });
                    stream.on('close', function() {
                        cb();
                        //conn.end();
                    })
                });
            });
        });
    });
}
*/

//update
router.put('/:id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.id;
    db.Resource.findOne({_id: id}, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end();
        if(resource.user_id != req.user.sub) return res.status(401).end();

        //need to decrypt first so that I can preserve previous values
        common.decrypt_resource(resource);
        //keep old value if enc_ fields are set to true
        for(var k in req.body.config) {
            if(k.indexOf("enc_") === 0) {
                var v = req.body.config[k];
                if(v === true) {
                    req.body.config[k] = resource.config[k];
                }
            }
        }
        common.encrypt_resource(req.body);
        db.Resource.update({_id: id}, { $set: req.body }, {new: true}, function(err) {
            if(err) return next(err);
            mask_enc(req.body);
            res.json(req.body);
        });
    });
});

//new
router.post('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var resource = new db.Resource(req.body);
    resource.user_id = req.user.sub;

    //if ssh_public is set (to anything), generate ssh_key and encrypt
    if(resource.config.ssh_public) {
        common.ssh_keygen(function(err, out){
            if(err) next(err);
            resource.config.ssh_public = out.pubkey;
            resource.config.enc_ssh_private = out.key;
            common.encrypt_resource(resource);
            save();
        });
    } else {
        save();
    }

    function save() {
        resource.save(function(err) {
            if(err) return next(err);
            res.json(mask_enc(resource));
        });
    }
});

router.post('/resetsshkeys/:id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.id;
    db.Resource.findOne({_id: id}, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end();
        if(resource.user_id != req.user.sub) return res.status(401).end();
        common.ssh_keygen(function(err, out){
            if(err) next(err);
            var resource = {
                config: {
                    ssh_public: out.pubkey,
                    enc_ssh_private: out.key,
                }
            }
            common.encrypt_resource(resource);
            db.Resource.update({_id: id}, { $set: resource }, {new: true}, function(err) {
                if(err) return next(err);
                res.json({ssh_public: resource.config.ssh_public, resource: resource});
            });
        });
    });
}); 

module.exports = router;

