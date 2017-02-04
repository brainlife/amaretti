'use strict';

//node
var fs = require('fs');
var child_process = require('child_process');

//contrib
var express = require('express');
var router = express.Router();
var winston = require('winston');
var jwt = require('express-jwt');
var async = require('async');
var path = require('path');
var multiparty = require('multiparty');
var mime = require('mime');
var request = require('request');

//mine
var config = require('../../config');
var logger = new winston.Logger(config.logger.winston);
var db = require('../models/db');
var common = require('../common');
var resource_lib = require('../resource');
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

/**
 * @apiGroup Resource
 * @api {get} /resource/types   Get all resource types
 * @apiDescription              Returns all resource types configured on the server
 * 
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object}         List of resources types (in key/value where key is resource type ID, and value is resource detail)
 */
router.get('/types', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    res.json(config.resources);
});

/**
 * @apiGroup Resource
 * @api {get} /resource         Query resource registrations
 * @apiDescription              Returns all resource registration instances that user has access to
 *
 * @apiParam {Object} [find]    Optional Mongo query to perform
 * @apiParam {Object} [sort]    Mongo sort object - defaults to _id. Enter in string format like "-name%20desc"
 * @apiParam {String} [select]  Fields to load - defaults to 'logical_id'. Multiple fields can be entered with %20 as delimiter
 * @apiParam {Number} [limit]   Maximum number of records to return - defaults to 100
 * @apiParam {Number} [skip]    Record offset for pagination (default to 0)
 * @apiParam {String} [user_id] (Only for sca:admin) Override user_id to search (default to sub in jwt). Set it to null if you want to query all users.
 * 
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object}         List of resources (maybe limited / skipped) and total number of resources
 */
router.get('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var find = {};
    if(req.query.where) find = JSON.parse(req.query.where); //deprecated
    if(req.query.find) find = JSON.parse(req.query.find);

    //shouldn't be needed, but in case auth service doesn't set it (or admin issued jwt)
    if(!req.user.gids) req.user.gids = [];

    if(!req.user.scopes.sca || !~req.user.scopes.sca.indexOf("admin") || find.user_id === undefined) {
        //non admin can only query resources that belongs to him/her or shared with his/her gids
        find["$or"] = [
            {user_id: req.user.sub},
            {gids: {"$in": req.user.gids}},
        ];
    } else if(find.user_id == null) {
        //admin can set it to null and remove user_id / gids filtering
        delete find.user_id;
    }
    //console.log(JSON.stringify(req.user, null, 4));
    //console.log(JSON.stringify(find, null, 4));

    db.Resource.find(find)
    .select(req.query.select)
    .limit(req.query.limit || 100)
    .skip(req.query.skip || 0)
    .sort(req.query.sort || '_id')
    .lean()
    .exec(function(err, resources) {
        if(err) return next(err);
        resources.forEach(mask_enc);
            
        //add / remove a few more things
        resources.forEach(function(resource) {
            resource.detail = config.resources[resource.resource_id]; //TODO deprecate this
            resource._detail = config.resources[resource.resource_id];
            resource.salts = undefined;
            //resource.canedit = (resource.user_id == req.user.sub);
        });
        db.Resource.count(find).exec(function(err, count) {
            if(err) return next(err);
            res.json({resources: resources, count: count});
        });
    });
});

/**
 * @api {get} /resource/ls/:resource_id      List directory
 * @apiGroup                    Resource
 * @apiDescription              Get directory listing on a resource on specified path. For HPSS resource, it will
 *                              query HPSS directory under specified path. Use "./" to query home directory, since
 *                              path is a required parameter.
 *
 * @apiParam {String} path      Path to load directory (relative to workdir)
 *
 * @apiHeader {String}          Authorization A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccessExample {json} Success-Response:
 *  {"files":[
 *      {   
 *          "filename":"config.json",
 *          "directory":false,
 *          "attrs": {
 *              "mode":33188,
 *              "mode_string":"-rw-r--r--",
 *              "uid":1170473,
 *              "owner": "hayashis",
 *              "gid":4160,
 *              "group": "hpss",
 *              "size":117,
 *              "atime":1466517617,
 *              "mtime":1466517617
 *          },
 *          "_raw":"-rw-r--r--    1 odidev   odi           117 Jun 21 10:00 config.json"
 *      }
 *  ]}
 */
//:resource_id is optional until I can migrate all existing client to use it (some uses req.query.resource_id still)
router.get('/ls/:resource_id?', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    //req.query.resource_id is deprecated .. use url param
    var resource_id = req.params.resource_id || req.query.resource_id;
    var _path = req.query.path; //TODO.. validate?
    if(!_path) return next("no path specified");
    db.Resource.findById(resource_id, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).json({message: "couldn't find the resource specified"});
        if(!common.check_access(req.user, resource)) return res.status(401).end(); 
        if(resource.status != "ok") return res.status(500).json({message: resource.status_msg});

        var detail = config.resources[resource.resource_id];
        switch(detail.type) {
        case "ssh":
            ls_resource(resource, _path, function(err, files) {
                if(err) return next(err);
                var ret = [];
                //bit of standardization with ls_hpss
                files.forEach(function(file) {
                    file.attrs.mode_string = file.longname.substr(0, 10);
                    ret.push({
                        filename: file.filename,
                        directory: file.attrs.mode_string[0]=='d',
                        attrs: {
                            mode: file.attrs.mode,     
                            mode_string: file.attrs.mode_string,
                            //permissions: file.mode,     
                            uid: file.attrs.uid,
                            gid: file.attrs.gid,
                            size: file.attrs.size,
                            atime: file.attrs.atime,
                            mtime: file.attrs.mtime,

                            owner: null,
                            group: null,
                        },
                        _raw: file.longname,
                        //_sftp: file,
                    });
                });
                res.json({files: ret});
            });
            break;
        case "hpss":
            common.ls_hpss(resource, _path, function(err, files) {
                if(err) return next(err);
                //need to convert output to the same format that ssh2.sftp returns
                var ret = [];
                files.forEach(function(file) {
                    ret.push({
                        filename: file.entry,
                        directory: file.directory,
                        attrs: {
                            mode: null, //TODO (convert -rw-rw-r-- to 33261, etc..)
                            mode_string: file.mode,
                            
                            //permissions: null, //TODO (convert -rw-rw-r-- to 33261, etc..)
                            uid: parseInt(file.acct),
                            gid: null, //hsi doesn't return gid (only group name)
                            size: file.size,
                            //atime: file.atime,
                            mtime: new Date(file.date).getTime()/1000,

                            //TODO not yet set for ssh ls
                            owner: file.owner,
                            group: file.group,
                        },
                        _raw: file._raw,
                        //pass other hpss specific stuff
                        //_debug: file,
                        _hpss: {
                            where: file.where,
                            links: file.links,
                            cos: file.cos,
                        }
                    });
                });  
                res.json({files: ret});
            });
            break;
        default:
            return next("don't know how to ls resource type:"+resource.type);
        }
    });
});

function ls_resource(resource, _path, cb) {
    //append workdir if relateive
    if(_path[0] != "/") _path = common.getworkdir(_path, resource);
    
    //for ssh resource, simply readdir via sftp
    logger.debug("getting ssh connection");
    common.get_sftp_connection(resource, function(err, sftp) {
        if(err) return cb(err);
        logger.debug("reading directory:"+_path);
        var t = setTimeout(function() {
            cb("Timed out while reading directory: "+_path);
            t = null;
        }, 5000);
        sftp.readdir(_path, function(err, files) {
            if(t) clearTimeout(t); 
            else return; //timeout called already
            cb(err, files);
        });
    });
}

//http://stackoverflow.com/questions/770523/escaping-strings-in-javascript
String.prototype.addSlashes = function() 
{ 
   //no need to do (str+'') anymore because 'this' can only be a string
   return this.replace(/[\\"']/g, '\\$&').replace(/\u0000/g, '\\0');
} 

router.delete('/file', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var resource_id = req.query.resource_id;
    var _path = req.query.path; //TODO.. validate?
    db.Resource.findById(resource_id, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).json({message: "couldn't find the resource specified"});
        if(!common.check_access(req.user, resource)) return res.status(401).end(); 
        if(resource.status != "ok") return res.status(500).json({message: resource.status_msg});

        //append workdir if relateive (should use path instead?)
        if(_path[0] != "/") _path = common.getworkdir(_path, resource);

        logger.debug("getting ssh connection");
        common.get_ssh_connection(resource, function(err, conn) {
            if(err) return next(err);
            logger.debug("rm \""+_path.addSlashes()+"\"");
            conn.exec("rm \""+_path.addSlashes()+"\"", function(err, stream) {
                if(err) return next(err);
                stream.on('end', function() {
                    res.json({msg: "file removed"});
                });
                //stream.resume(); //needed now for ssh2>0.5 .. *IF* I don't use on('data')
                stream.on('data', function(data) {
                    logger.error(data.toString());
                });  
            });
        });
    });
});

//return a best resource for a given purpose / criteria
router.get('/best', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    logger.debug("choosing best resource for service:"+req.query.service);
    //logger.debug("dumping req.user");
    //logger.debug(req.user);

    var query = {};
    if(req.query.service) query.service = req.query.service;
    if(req.query.resource_type) query.resource_type = req.query.resource_type;

    resource_lib.select(req.user, query, function(err, resource, score) {
        if(err) return next(err);
        //logger.debug(resource);
        if(!resource) return res.json({nomatch: true});
        var resource_detail = config.resources[resource.resource_id];
        var ret = {
            score: score,
            resource: mask_enc(resource),
            detail: resource_detail,
            workdir: common.getworkdir(null, resource),
        };
        res.json(ret);
    });
});

//TODO - should use sftp/mkdir ?
function mkdirp(conn, dir, cb) {
    //var dir = path.dirname(_path);
    logger.debug("mkdir -p "+dir);
    conn.exec("mkdir -p "+dir, {}, function(err, stream) {
    //conn.exec("whoami", {}, function(err, stream) {
        if(err) return cb(err);
        /*
        stream.on('close', function(code, signal) {
            logger.log("mkdir -p done");
            cb();
        });
        */
        stream.on('end', function(data) {
            logger.debug("mkdirp done");
            logger.debug(data);
            cb();
        });
        //stream.resume(); //needed now for ssh2>0.5 .. IF I don't use on('data')
        stream.on('data', function(data) {
            logger.error(data.toString());
        });
    });
}

//TODO - deprecate this and use the streaming version below.. 
//ng-upload uses multipart so it won't work, but I can use XMLHttpRequest (see sca-wf-onere)
//handle file upload request via multipart form
//takes resource_id and path via headers (mkdirp path if it doesn't exist)
router.post('/upload', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    logger.error("(post)/upload is now deprecated - use (post)/upload/:resource_id/:path method instead");
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
            if(resource.status != "ok") return res.status(500).json({message: resource.status_msg});

            if(!common.check_access(req.user, resource)) return res.status(401).end(); 
            common.get_ssh_connection(resource, function(err, conn) {
                if(err) return next(err);
                //logger.debug("calling mkdirp");
                //append workdir if relateive (TODO should use node path module?)
                if(fields.path[0] != "/") fields.path = common.getworkdir(fields.path, resource);
                //logger.debug("mkdirp: "+fields.path);
                mkdirp(conn, fields.path, function(err) {
                    if(err) return next(err);
                    logger.debug("opening sftp connection");
                    conn.sftp(function(err, sftp) {
                        if(err) return next(err);
                        //var escaped_filename = part.filename.replace(/"/g, '\\"');
                        //var _path = fields.path+"/"+escaped_filename;
                        var _path = fields.path+"/"+part.filename;

                        logger.debug("streaming file to "+_path);
                        var stream = sftp.createWriteStream(_path);
                        part.pipe(stream).on('close', function() {
                            logger.debug("streaming closed");
                            sftp.stat(_path, function(err, stat) {
                                sftp.end();
                                if(err) return next(err);
                                res.json({file: {filename: part.filename, attrs: stat}});
                            });
                        });
                    });
                });
            });
        });
    });
    form.parse(req);
});

//simpler streaming 
router.post('/upload/:resourceid/:path', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.resourceid;
    var _path = (new Buffer(req.params.path, 'base64').toString('ascii'));
    logger.debug("path: "+_path);
    db.Resource.findOne({_id: id}, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end();
        //if(resource.user_id != req.user.sub) return res.status(401).end();
        if(!common.check_access(req.user, resource)) return res.status(401).end(); 
        common.get_ssh_connection(resource, function(err, conn) {
            if(err) return next(err);
            var fullpath = common.getworkdir(_path, resource);
            //logger.debug("mkdirp "+path.dirname(fullpath));
            mkdirp(conn, path.dirname(fullpath), function(err) {
                if(err) return next(err);
                conn.sftp(function(err, sftp) {
                    if(err) return next(err);
                    logger.debug("streaming file to "+_path);
                    req.pipe(sftp.createWriteStream(fullpath))
                    .on('close', function() {
                        logger.debug("streaming closed");
                        sftp.stat(fullpath, function(err, stat) {
                            sftp.end();
                            if(err) return next(err);
                            res.json({filename: path.basename(fullpath), attrs: stat});
                        });
                    });
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
//Another way to mitigate this is to issue a temporary jwt token used to do file download (or permanent token that's tied to the URL?)
/**
 * @api {get} /resource/download         Download file from resource. If directory path is specified, it will stream tar -gz content
 * @apiParam {String} r         Resource ID
 * @apiParam {String} p         File/directory path to download (relative to resource work directory - parent of all instance dir)
 * @apiParam {String} [at]      JWT token - if user can't provide it via authentication header
 *
 * @apiDescription              Allows user to download any files from user's resource
 *
 * @apiGroup Resource
 * 
 * @apiHeader {String} [authorization] A valid JWT token "Bearer: xxxxx"
 *
 */
router.get('/download', jwt({
    secret: config.sca.auth_pubkey,
    getToken: function(req) { 
        //load token from req.headers as well as query.at
        if(req.query.at) return req.query.at; 
        if(req.headers.authorization) {
            var auth_head = req.headers.authorization;
            if(auth_head.indexOf("Bearer") === 0) return auth_head.substr(7);
        }
        return null;
    }
}), function(req, res, next) {
    var resource_id = req.query.r;
    var _path = req.query.p;

    //logger.debug("downoad request on resource_id:"+resource_id);
    //logger.debug("path:"+_path);

    if(!_path) return next("Please specify path(p)");
    if(!resource_id) return next("Please specify resource id(r)");
    
    //make sure user is loading things under the sca workdir and nothing else
    //TODO this is nowhere near good enough..
    if(_path[0] == "/") return next("only download relateive to workdir");
    if(~_path.indexOf("..")) return next("only download relateive to workdir");

    db.Resource.findById(resource_id, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).json({message: "couldn't find the resource specified"});
        if(!common.check_access(req.user, resource)) return res.status(401).end(); 
        if(resource.status != "ok") return res.status(500).json({message: resource.status_msg});
        
        //append workdir if relateive (TODO - or should I limit under workdir?)
        //if(_path[0] != "/") _path = common.getworkdir(_path, resource);

        common.get_sftp_connection(resource, function(err, sftp) {
            if(err) return next(err);
            var fullpath = common.getworkdir(_path, resource);
            sftp.stat(fullpath, function(err, stat) {
                if(err) return next(err);
                //logger.debug(stat);
                if(stat.isDirectory()) {   
                    //it's directory .. stream using tar | gzip
                    common.get_ssh_connection(resource, function(err, conn) {
                        if(err) return next(err);
                        //create a nice tar.gz name
                        var name = _path.replace(/\//g, '.')+'.tar.gz';
                        res.setHeader('Content-disposition', 'attachment; filename='+name);
                        res.setHeader('Content-Type', "application/x-tgz");
                        var workdir = common.getworkdir("", resource);
                        conn.exec("cd \""+workdir+"\" && tar cz \""+_path.addSlashes()+"\" | gzip -f", function(err, stream) {
                            if(err) return next(err);
                            stream.pipe(res);
                        });
                    });
                } else {
                    //file .. just stream using sftp stream
                    //npm-mime uses filename to guess mime type, so I can use this locally
                    var mimetype = mime.lookup(fullpath);
                    logger.debug("mimetype:"+mimetype);

                    //without attachment, the file will replace the current page
                    res.setHeader('Content-disposition', 'attachment; filename='+path.basename(fullpath));
                    res.setHeader('Content-Length', stat.size);
                    res.setHeader('Content-Type', mimetype);
                    var stream = sftp.createReadStream(fullpath);
                    stream.pipe(res);               
                }
            });
        });
    });
});

/**
 * @api {put} /resource/test/:resource_id Test resource 
 * @apiName TestResource
 * @apiGroup Resource
 *
 * @apiDescription Test resource connectivity and availability. Store status on status/status_msg fields of the resource entry
 * 
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 * @apiSuccessExample {json} Success-Response:
 *     HTTP/1.1 200 OK
 *     {
 *         "status": "ok"
 *     }
 *
 * @apiErrorExample {json} Error-Response:
 *     HTTP/1.1 500 OK
 *     {
 *         "message": "SSH connection failed"
 *     }
 *
 */
router.put('/test/:id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.id;
    db.Resource.findOne({_id: id}, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end();
        //if(resource.user_id != req.user.sub) return res.status(401).end();
        if(!common.check_access(req.user, resource)) return res.status(401).end(); 
        logger.info("testing resource:"+id);
        resource_lib.check(resource, function(err, ret) {
            if(err) return next(err);
            res.json(ret);
        });
    });
});

/**
 * @api {put} /resource/:id     Update resource instance configuration
 * @apiName UpdateResource
 * @apiGroup Resource
 *
 * @apiParam {String} id        Resource Instance ID to update
 *
 * @apiParam {Object} [config]    Resource Configuration to update
 * @apiParam {Object} [envs]      Resource environment parameters to update
 * @apiParam {String} [name]      Name of this resource instance
 * @apiParam {String} [hostname]  Hostname to override the resource base hostname
 * @apiParam {Object[]} [services] Array of name: and score: to add to the service provides on resource base
 * @apiParam {Number[]} [gids]    List of groups that can use this resource (only sca admin can update)
 * @apiParam {Boolean} [active]   Set true to enable resource
 *
 * @apiDescription Update the resource instance (only the resource that user owns)
 * 
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 * @apiSuccess {Object} Resource Object
 *
 */
router.put('/:id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.id;
    db.Resource.findOne({_id: id}, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end();
        if(resource.user_id != req.user.sub) return res.status(401).end();

        //only admin can update gids
        if(!req.user.scopes.sca || !~req.user.scopes.sca.indexOf("admin")) {
            delete resource.gids;
        }

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

        //decrypt again and save
        common.encrypt_resource(req.body);
        db.Resource.update({_id: id}, { $set: req.body }, {new: true}, function(err) {
            if(err) return next(err);
            mask_enc(req.body);
            res.json(req.body);
        });
    });
});

//it's dangerous to allow anyone to share resources with any groups.
//task could get submitted there without other user's being aware.. 
//for now, only administrators can update gids

/**
 * @api {post} /resource        Register new resource instance
 * @apiName NewResource
 * @apiGroup Resource
 *
 * @apiParam {String} type      "hpss", or "ssh" for now
 * @apiParam {String} resource_id ID of this resource instance ("karst", "mason", etc..)
 * @apiParam {Object} config    Configuration for resource
 * @apiParam {Object} [envs]    Key values to be inserted for service execution
 * @apiParam {String} [name]    Name of this resource instance (like "soichi's karst account")
 * @apiParam {String} [hostname]  Hostname to override the resource base hostname
 * @apiParam {Object[]} [services] Array of name: and score: to add to the service provides on resource base
 * @apiParam {Number[]} [gids]  List of groups that can use this resource (only sca admin can enter this)
 * @apiParam {Boolean} [active] Set true to enable resource
 *
 * @apiDescription Just create a DB entry for a new resource - it doesn't test resource / install keys, etc..
 * 
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 * @apiSuccessExample {json} Success-Response:
 *     HTTP/1.1 200 OK
 *     { __v: 0,
 *      user_id: '9',
 *      gids: [1,2,3],
 *      type: 'ssh',
 *      resource_id: 'karst',
 *      name: 'use foo\'s karst account',
 *      config: 
 *       { ssh_public: 'my public key',
 *         enc_ssh_private: true,
 *         username: 'hayashis' },
 *      _id: '5758759710168abc3562bf01',
 *      update_date: '2016-06-08T19:44:23.205Z',
 *      create_date: '2016-06-08T19:44:23.204Z',
 *      active: true }
 *
 */
router.post('/', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var resource = new db.Resource(req.body);
    
    //only admin can update gids
    if(!req.user.scopes.sca || !~req.user.scopes.sca.indexOf("admin")) {
        delete resource.gids;
    }

    resource.user_id = req.user.sub;
    common.encrypt_resource(resource);
    resource.save(function(err, _resource) {
        if(err) return next(err);
        res.json(mask_enc(_resource));
    });
});

/**
 * @api {delete} /resource/:id Remove resource
 * @apiName RemoveResource
 * @apiGroup Resource
 *
 * @apiParam {String} id Resource ID
 * @apiDescription Remove resource instance
 * 
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 * @apiSuccess {String} ok
 *
 */
router.delete('/:id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {
    var id = req.params.id;
    db.Resource.findOne({_id: id}, function(err, resource) {
        if(err) return next(err);
        if(!resource) return res.status(404).end("couldn't find such resource");
        if(resource.user_id != req.user.sub) return res.status(401).end("you don't own this resource");
        resource.remove(function(err) {
            if(err) return next(err);
            console.log("done removing");
            res.json({status: 'ok'});
        });
    });
});

/**
 * @api {get} /resource/gensshkey Generate ssh key pair
 * @apiName GENSSHKEYResource
 * @apiGroup Resource
 *
 * @apiDescription 
 *      Used by resource editor to setup new resource
 *      jwt is optional.. since it doesn't really store this anywhere (should I?)
 *      kdinstaller uses this to generate key (and scott's snapshot tool)
 *      In the future, this might be moved to a dedicated SCA util API service (or deprecated)
 * 
 * //@apiHeader {String} [authorization] A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccessExample {json} Success-Response:
 *     HTTP/1.1 200 OK
 *     { pubkey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDDxtMlosV+/5CutlW3YIO4ZomH6S0+3VmDlAAYvBXHD+ut4faGAZ4XuumfJyg6EAu8TbUo+Qj6+pLuYLcjqxl2fzI6om2SFh9UeXkm1P0flmgHrmXnUJNnsnyen/knJtWltwDAZZOLj0VcfkPaJX7sOSp9l/8W1+7Qb05jl+lzNKucpe4qInh+gBymcgZtMudtmurEuqt2eVV7W067xJ7P30PAZhZa7OwXcQrqcbVlA1V7yk1V92O7Qt8QTlLCbszE/xx0cTEBiSkmkvEG2ztQQl2Uqi+lAIEm389quVPJqjDEzaMipZ1X5xgfnyDtBq0t/SUGZ8d0Ki1H0jmU7H//',
 *       key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAKCAQEAw8 ... CeSZ6sKiQmE46Yh4/zyRD4JgW4CY=\n-----END RSA PRIVATE KEY-----' }
 *
router.get('/gensshkey', jwt({secret: config.sca.auth_pubkey, credentialsRequired: false}), function(req, res, next) {
    common.ssh_keygen({
        //ssh-keygen opts (https://github.com/ericvicenti/ssh-keygen)
        destroy: true,
        comment: req.query.comment,
        password: req.query.password,
    }, function(err, out) {
        if(err) return next(err);
        res.json(out);
    });
});
*/

//intentionally left undocumented
//TODO - limit access to certain IP range
router.post('/installsshkey', function(req, res, next) {
    var username = req.body.username;
    var password = req.body.password;
    var host = req.body.hostname || req.body.host;
    var pubkey = req.body.pubkey;
    var comment = req.body.comment;

    if(username === undefined) return next("missing username");
    if(password === undefined) return next("missing password");
    if(host === undefined) return next("missing hostname");
    if(pubkey === undefined) return next("missing pubkey");
    if(comment === undefined) return next("missing comment");

    var command = 'wget --no-check-certificate https://raw.githubusercontent.com/soichih/sca-wf/master/bin/install_pubkey.sh -O - | PUBKEY=\"'+pubkey+'\" COMMENT=\"'+comment+'\" bash';
    common.ssh_command(username, password, host, command, function(err) {
        if(err) return next(err);
        res.json({message: 'ok'});
    });
});

//intentionally left undocumented
router.post('/setkeytab/:resource_id', jwt({secret: config.sca.auth_pubkey}), function(req, res, next) {

    var resource_id = req.params.resource_id;

    var username = req.body.username;
    var password = req.body.password;

    if(username === undefined) return next("missing username");
    if(password === undefined) return next("missing password");

    db.Resource.findById(resource_id, function(err, resource) {
        if(err) return next(err);
        //console.dir(resource);
        if(!resource) return res.status(404).json({message: "couldn't find the resource specified"});
        if(!common.check_access(req.user, resource)) return res.status(401).end(); 
        if(resource.type != "hpss") return res.status(404).json({message: "not a hpss resource"});
        if(resource.status != "ok") return res.status(500).json({message: resource.status_msg});

        //need to decrypt first..
        common.decrypt_resource(resource);

        resource.config.auth_method = "keytab";
        resource.config.username = username;

        child_process.exec(__dirname+"/../../bin/gen_keytab.sh", {
            env: {
                USERNAME: username,
                PASSWORD: password,
            }
        }, function(err, stdout, stderr) {
            if(err) return next(err); //exit 1 will be handled here
            resource.config.enc_keytab = stdout.trim();
            
            //decrypt again and save
            common.encrypt_resource(resource);
            resource.save(function(err) {
                if(err) return next(err);
                res.json({message: 'ok'});
            });
        })
    });
});

module.exports = router;

