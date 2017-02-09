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

    //(DEPRECATE? - use config.workflow or such..) name of workflow you'd like to use
    workflow_id: String, 

    config: mongoose.Schema.Types.Mixed,

    /*
    //(TODO) this is an experimental object to be used by sca-event
    task_status: mongoose.Schema.Types.Mixed,
    //example....
    //stores list of all task status {
    //"12345<taskid>": {
    //    status: "running",
    //    }
    //}
    */

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

instanceSchema.post('save', events.instance);
instanceSchema.post('findOneAndUpdate', events.instance);
instanceSchema.post('findOneAndRemove', events.instance);
instanceSchema.post('remove', events.instance);

exports.Instance = mongoose.model('Instance', instanceSchema);

///////////////////////////////////////////////////////////////////////////////////////////////////

var resourceSchema = mongoose.Schema({
    ////////////////////////////////////////////////
    //key
    user_id: {type: String, index: true}, 

    active: {type: Boolean, default: true},

    name: String, 
    
    //DEPRECATED... don't use this.. just lookup resource config via resource_id and use the type specified there
    type: String, 

    resource_id: String, //like sda, bigred2 (resource base id..)

    /* stored in config
    hostname: String, //hostname to override from base hostname
    services: [ new mongoose.Schema({
        name: String, //soichih/sca-service-noop,
        score: Number,
    }) ],  //services to allow running (additional to base services)
    */

    config: mongoose.Schema.Types.Mixed,
    envs: mongoose.Schema.Types.Mixed, //envs to inject for service execution (like HPSS_BEHIND_FIREWALL)

    gids: [{type: Number}], //if set, these set of group can access this resource (only admin can set it)

    //current resource status
    status: String,
    status_msg: String,
    status_update: Date, //update_date is for updating the resource config.. status_update is the date of last status check
    lastok_date: Date, //date which status was last ok... used to auto-deactivate if status remains non-ok for long period of time

    create_date: {type: Date, default: Date.now },
    update_date: {type: Date, default: Date.now },
});
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

    run: {type: Number, default: 0 }, //number of time this task has been attempted to run
    retry: {type: Number, default: 0 }, //number of time this task should be re-tried. 0 means only run once.
  
    ///////////////////////////////////////////////////////////////////////////////////////////////
    // fields set by sca-task 

    status: String,  //requested, running, failed, stop_requested, stopped, (running_sync), removed, 
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

taskSchema.post('save', events.task);
taskSchema.post('findOneAndUpdate', events.task);
taskSchema.post('findOneAndRemove', events.task);
taskSchema.post('remove', events.task);

taskSchema.index({name: 'text', desc: 'text'});
taskSchema.index({status: 1, next_date: 1}); //index for sca-wf-task

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


