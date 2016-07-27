'use strict';

//contrib
var mongoose = require('mongoose');
var winston = require('winston');

//mine
var config = require('../../config');
var logger = new winston.Logger(config.logger.winston);

exports.init = function(cb) {
    mongoose.connect(config.mongodb, {}, function(err) {
        if(err) return cb(err);
        logger.info("connected to mongo");
        cb();
    });
}
exports.disconnect = function(cb) {
    mongoose.disconnect(cb);
}

///////////////////////////////////////////////////////////////////////////////////////////////////

//workflow instance
var instanceSchema = mongoose.Schema({

    workflow_id: String, //"sca-wf-life"

    name: String, //name of the workflow
    desc: String, //desc of the workflow

    //user that this workflow instance belongs to
    user_id: {type: String, index: true}, 

    config: mongoose.Schema.Types.Mixed,

    create_date: {type: Date, default: Date.now },
    update_date: {type: Date, default: Date.now },
});
/*
//mongoose's pre/post are just too fragile.. it gets call on some and not on others.. (like findOneAndUpdate)
//I prefer doing this manually anyway, because it will be more visible 
instanceSchema.pre('update', function(next) {
    this.update_date = new Date();
    next();
});
*/
exports.Instance = mongoose.model('Instance', instanceSchema);

///////////////////////////////////////////////////////////////////////////////////////////////////

var resourceSchema = mongoose.Schema({
    ////////////////////////////////////////////////
    //key
    user_id: {type: String, index: true}, 
    type: String, //like hpss, pbs (from resource base)
    resource_id: String, //like sda, bigred2 (resource base id..)
    //
    //TODO - allow resource to override parameters from resource base so that user can configure them
    //
    ////////////////////////////////////////////////

    gids: [{type: Number}], //if set, these set of group can access this resource

    status: String,
    status_msg: String,
    status_update: Date,

    active: {type: Boolean, default: true},

    name: String, 
    config: mongoose.Schema.Types.Mixed,
    envs: mongoose.Schema.Types.Mixed, //envs to inject for service execution (like HPSS_BEHIND_FIREWALL)

    //salts: mongoose.Schema.Types.Mixed, //salts used to encrypt fields in config (that starts with enc_)

    create_date: {type: Date, default: Date.now },
    update_date: {type: Date, default: Date.now },
});

/*
//mongoose's pre/post are just too fragile.. it gets call on some and not on others.. (like findOneAndUpdate)
//I prefer doing this manually anyway, because it will be more visible 
resourceSchema.pre('update', function(next) {
    //this._update.$set.update_date = new Date();
    this.update_date = new Date();
    next();
});
*/
exports.Resource = mongoose.model('Resource', resourceSchema);

///////////////////////////////////////////////////////////////////////////////////////////////////

var taskSchema = mongoose.Schema({

    user_id: String, //sub of user submitted this request

    instance_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Instance'},
    service: String, // "soichih/sca-service-life"
    
    //resource where the service was executed (not set if it's not yet run)
    resource_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Resource'},

    //resource to be selected if multiple resource is available and score ties
    preferred_resource_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Resource'},
    
    //environment parameters set in _boot.sh (nobody uses this.. just to make debugging easier)
    _envs: mongoose.Schema.Types.Mixed,
    
    //content of products.json once generated
    products: mongoose.Schema.Types.Mixed,

    progress_key: {type: String, index: true}, 

    status: String, 
    status_msg: String,
    status_update: Date,

    //if this document is handled by sca-task, this will be set to hostname, pid, timestamp of the sca-task
    //_handled: mongoose.Schema.Types.Mixed,
    
    //object containing details for this task
    config: mongoose.Schema.Types.Mixed, 

    //envs to inject for service execution (like HPSS_BEHIND_FIREWALL)
    envs: mongoose.Schema.Types.Mixed, 

    //task dependencies required to run the service 
    deps: [ {type: mongoose.Schema.Types.ObjectId, ref: 'Task'} ],

    //resource dependencies.. 
    //for hpss, it will copy the heytab
    resource_deps: [ {type: mongoose.Schema.Types.ObjectId, ref: 'Resource'} ],

    //list of resource where the output directory is synchronized (TODO - not sure if I will use this or not)
    //resources: [ {type: mongoose.Schema.Types.ObjectId, ref: 'Resource'} ],

    //TEXT INDEX field to be searchable with text search
    name: String, 
    desc: String, 

    //time when this task was requested
    request_date: {type: Date},
    
    //time when this task was last attempted by sca-task
    handled_date: {type: Date},
    
    //time when this task started running
    start_date: {type: Date},
    
    //time when this task was finished
    finish_date: {type: Date},

    //time when this task was originally created
    create_date: {type: Date, default: Date.now },

    //time when this task was last updated
    update_date: {type: Date},
});
/*
//mongoose's pre/post are just too fragile.. it gets call on some and not on others.. (like findOneAndUpdate)
//I prefer doing this manually anyway, because it will be more visible 
taskSchema.pre('update', function(next) {
    this.update_date = new Date();
    next();
});
*/
taskSchema.index({name: 'text', desc: 'text'});

exports.Task = mongoose.model('Task', taskSchema);

///////////////////////////////////////////////////////////////////////////////////////////////////

//used to comments on various *things*
var commentSchema = mongoose.Schema({

    type: String, //workflow, instance, task, etc..
    subid: String, //workflow_id, instance_id, whatever... could be not set

    user_id: String, //author user id
    create_date: {type: Date, default: Date.now },
    text: String, //content of the comment

    //profile cache to speed things up
    //TODO update this cache periodically, or whenever user changes profile
    _profile: mongoose.Schema.Types.Mixed,
});
exports.Comment = mongoose.model('Comment', commentSchema);

///////////////////////////////////////////////////////////////////////////////////////////////////

//registered services
var serviceSchema = mongoose.Schema({

    //user who registered this service to SCA
    user_id: String, 

    giturl: String, //url used to register this service
    
    //unique service name used by SCA (normally a copy of git.full_name when registered -- "soichih/sca-service-life")
    name: {type: String, index: {unique: true}}, 

    //cache of https://api.github.com/repos/soichih/sca-service-life
    git: mongoose.Schema.Types.Mixed, 
    //important git fields
    //git.description - repo desc
    //git.clone_url

    //cache of package.json (https://raw.githubusercontent.com/soichih/sca-service-freesurfer/master/package.json)
    pkg: mongoose.Schema.Types.Mixed, 
    //important pkg fields
    //pkg.scripts.start
    //pkg.scripts.stop
    //pkg.scripts.status

    //information about the last test
    status: String,
    status_msg: String,
    status_update: Date,

    //owner / admin can deactivate
    active: {type: Boolean, default: true},

    register_date: {type: Date, default: Date.now },
});
exports.Service = mongoose.model('Service', serviceSchema);


