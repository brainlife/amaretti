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

//mine
var config = require('../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models/db');
var common = require('../common');
var resource_picker = require('../resource_picker');

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
    .exec(function(err, resources) {
        if(err) return next(err);
        resources.forEach(mask_enc);
        res.json(resources);
    });
});

//return a best resource (including unencrypted password / privatekey) for given task 
//(likely to be deprecated... only sca service should be responsible for picking the 
//best resource, and dealing with decrypted config
router.get('/best', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    resource_picker.select(req.query, req.user.sub, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end();
        var resource_detail = config.resources[resource.resource_id];

        var ret = {
            detail: resource_detail,
            user: resource,
            workdir: common.getworkdir("", resource),
        };
        
        //TODO this should go away when/if I build resource service that can stream IO via socket.io-stream
        //don't forget to get rid of decrypt_resource then
        if(req.query._addsecret) {
            common.decrypt_resource(resource);
            ret._secrets = {
                username: resource.config.username,
                private_key: resource.config.enc_ssh_private,
                hostname: resource_detail.hostname,
            }
        }

        res.json(ret);
    });
});

//TODO.. this should prevnet _secrets to leak out in /best
router.post('/upload', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var resource_id = req.body.resource_id;
    var _path = req.query.p;
});

router.post('/exec', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var resource_id = req.body.resource_id;
    var cmd = req.body.cmd;
    db.Resource.findById(resource_id, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).json({message: "couldn't find the resource specified"});
        if(resource.user_id != req.user.sub) return res.status(401).end(); 
        common.get_ssh_connection(resource, function(conn) {
            var workdir = common.getworkdir("", resource);
            conn.exec("cd "+workdir+" && "+cmd, function(err, stream) {
                if(err) return cb(err);
                stream.on('data', function(data) {
                    res.write(data);
                });
                stream.on('end', function(data) {
                    res.end();
                    conn.end();
                });
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
    console.dir(_path);

    //TODO - this validation isn't good enough.. (use can use escape, etc..)
    if(~_path.indexOf("..")) return next("invalid path");

    db.Resource.findById(resource_id, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).json({message: "couldn't find the resource specified"});
        if(resource.user_id != req.user.sub) return res.status(401).end(); 
        var fullpath = common.getworkdir(_path, resource);
        stream_remote_file(resource, _path, res, function(err) {
            if(err) return next(err);
        });
    });
});

//stream file content via ssh using cat..  through sca web server
//TODO - I need to use something like data service - except that it does the fetching of data through resource information
function stream_remote_file(resource, _path, res, cb) {
    common.get_ssh_connection(resource, function(conn) {
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
                        conn.end();
                    })
                });
            });
        });
    });
}

//update
router.put('/:id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.id;
    /*
    db.Resource.findOneAndUpdate({_id: id, user_id: req.user.sub}, {$set: resource}, {new: true}, function(err, resource) {
        if(err) return next(err);
        res.json(resource);
    });
    */
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

