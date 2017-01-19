'use strict';

//contrib
const mongoose = require('mongoose');
const winston = require('winston');

//mine
const config = require('../../config');
const logger = new winston.Logger(config.logger.winston);
const events = require('../events');

//use native promise for mongoose
//without this, I will get Mongoose: mpromise (mongoose's default promise library) is deprecated
mongoose.Promise = global.Promise; 

exports.init = function(cb) {
    mongoose.connect(config.mongodb, {
        server: { auto_reconnect: true, reconnectTries: Number.MAX_VALUE}
    }, function(err) {
        if(err) return cb(err);
        logger.info("connected to mongo");
        cb();
    });
}
exports.disconnect = function(cb) {
    mongoose.disconnect(cb);
}

///////////////////////////////////////////////////////////////////////////////////////////////////

//*workflow* instance
var instanceSchema = mongoose.Schema({


    name: String, //name of the workflow
    desc: String, //desc of the workflow

    //user that this workflow instance belongs to
    user_id: {type: String, index: true}, 

    //(DEPRECATE?) name of workflow you'd like to use
    workflow_id: String, 

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

    //DEPRECATED... don't use this.. just lookup resource config via resource_id and use the type specified there
    type: String, 

    resource_id: String, //like sda, bigred2 (resource base id..)
    //
    //TODO - allow resource to override parameters from resource base so that user can configure them
    //
    ////////////////////////////////////////////////

    gids: [{type: Number}], //if set, these set of group can access this resource

    status: String,
    status_msg: String,
    status_update: Date, //update_date is for updating the resource config.. status_update is the date of last status check
    lastok_date: Date, //date which status was last ok... used to auto-deactivate if status remains non-ok for long period of time

    active: {type: Boolean, default: true},

    name: String, 
    config: mongoose.Schema.Types.Mixed,
    envs: mongoose.Schema.Types.Mixed, //envs to inject for service execution (like HPSS_BEHIND_FIREWALL)

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
    
    //time when this task was requested
    request_date: {type: Date},

    //progress service key for this task
    progress_key: {type: String, index: true}, 

    ///////////////////////////////////////////////////////////////////////////////////////////////
    // fields that user can set during request

    //workflow instance id
    instance_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Instance'},

    service: String, // "soichih/sca-service-life"
    service_branch: String, //master by default
       
    //TEXT INDEX field (below) to be searchable with text search
    name: String, 
    desc: String, 
  
    //resource to be selected if multiple resource is available and score ties
    preferred_resource_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Resource'},

    //object containing details for this task
    config: mongoose.Schema.Types.Mixed, 

    //envs to inject for service execution (like HPSS_BEHIND_FIREWALL)
    envs: mongoose.Schema.Types.Mixed, 

    //task dependencies required to run the service 
    deps: [ {type: mongoose.Schema.Types.ObjectId, ref: 'Task'} ],

    //resource dependencies..  (for hpss, it will copy the heytab)
    resource_deps: [ {type: mongoose.Schema.Types.ObjectId, ref: 'Resource'} ],

    //date when the task dir will be removed
    //(TODO .. if not set,  task will be archived based on resource configuration - like in 30 days)
    remove_date: Date,

    //array of notification objects to handle (see apidoc for tasks)
    //notifications: [ mongoose.Schema.Types.Mixed ] ,
  
    ///////////////////////////////////////////////////////////////////////////////////////////////
    // fields set by sca-task 

    status: String,  //requested, running, failed, stop_requested, stopped, running_sync, removed, 
    status_msg: String,
    status_update: Date, //TODO - is this still used?

    //resource where the task is running (or was)
    resource_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Resource'},

    //resources where task dir exits
    resource_ids: [ {type: mongoose.Schema.Types.ObjectId, ref: 'Resource'} ],
    
    //environment parameters set in _boot.sh (nobody uses this.. just to make debugging easier)
    _envs: mongoose.Schema.Types.Mixed,
    
    //content of products.json once generated
    products: mongoose.Schema.Types.Mixed,
 
    //next time sca-task should check this task again (unset to check immediately)
    next_date: {type: Date},
    
    //time when this task started running
    start_date: {type: Date},
    
    //time when this task was finished
    finish_date: {type: Date},

    //time when this task was originally created
    create_date: {type: Date, default: Date.now },

    //time when this task was last updated (only used by put api?)
    update_date: {type: Date},
});

/*
//mongoose's pre/post middleware are just too fragile.. it gets call on some and not on others.. (like findOneAndUpdate)
//see https://github.com/Automattic/mongoose/issues/964

//I prefer doing this manually anyway, because it will be more visible 
taskSchema.pre('update', function(next) {
    this.update_date = new Date();
    next();
});
*/

//TODO - not sure "init" does what I think it does.. 
//from doc "called internally after a document is returned from mongodb"
//taskSchema.post('init',events.create); 

//'update' hook doesn't pass the object updated.. so it's useless
//taskSchema.post('update', events.task); 

taskSchema.post('save', events.task);
taskSchema.post('findOneAndUpdate', events.task);
taskSchema.post('findOneAndRemove', events.task);
taskSchema.post('remove', events.task);

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

/*
//registered services
var serviceSchema = mongoose.Schema({

    //user who registered this service to SCA
    user_id: String, 

    //giturl: String, //url used to register this service
    
    //unique service name used by SCA (normally a copy of git.full_name when registered -- "soichih/sca-service-life")
    name: {type: String, index: {unique: true}}, 

    //cache of https://api.github.com/repos/soichih/sca-service-life
    git: mongoose.Schema.Types.Mixed, 

    //cache of package.json (https://raw.githubusercontent.com/soichih/sca-service-freesurfer/master/package.json)
    pkg: mongoose.Schema.Types.Mixed, 

    //information about the last test
    status: String,
    status_msg: String,
    status_update: Date,

    //owner / admin can deactivate
    active: {type: Boolean, default: true},

    register_date: {type: Date, default: Date.now },

    //date when the pkg info is last cached
    cache_date: {type: Date, default: Date.now },
});
exports.Service = mongoose.model('Service', serviceSchema);
*/

