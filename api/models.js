'use strict';

//contrib
const mongoose = require('mongoose');
const winston = require('winston');

//mine
const config = require('../config');
const logger = new winston.Logger(config.logger.winston);
const events = require('./events');

//use native promise for mongoose
//without this, I will get Mongoose: mpromise (mongoose's default promise library) is deprecated
mongoose.Promise = global.Promise; 

exports.init = function(cb) {
    mongoose.connect(config.mongodb, {
        //TODO - isn't auto_reconnect set by default?
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
    status: String, //instance status (computed from tasks inside it)

    create_date: {type: Date, default: Date.now },
    update_date: {type: Date, default: Date.now },

    //instance is just a grouping of tasks, so let's not have its own flag that really means much
    //but rather, compute it from all child tasks and set status to correct value
    //removed: { type: Boolean, default: false} ,
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

///////////////////////////////////////////////////////////////////////////////////////////

var resourceSchema = mongoose.Schema({
    ////////////////////////////////////////////////
    //key
    user_id: {type: String, index: true}, 
    active: {type: Boolean, default: true},
    name: String, 
    
    //DEPRECATED... don't use this.. just lookup resource config via resource_id and use the type specified there
    type: String, 

    resource_id: String, //like sda, bigred2 (resource base id..)

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

///////////////////////////////////////////////////////////////////////////////////////////

var taskSchema = mongoose.Schema({

    user_id: String, //sub of user submitted this request
    
    //time when this task was requested
    request_date: {type: Date},

    //progress service key for this task
    progress_key: {type: String, index: true}, 

    ////////////////////////////////////////////////////////////////////////////////////////
    // fields that user can set during request

    //workflow instance id
    instance_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Instance', index: true},

    //github repo
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

    //date when the task dir should be removed (if not requested or running) - if not set, will be remved after 25 days
    remove_date: Date,

    //mili-seconds after start_date to stop running job (default to 20 days)
    max_runtime: { type: Number, default: 1000*3600*24*20},

    run: {type: Number, default: 0 }, //number of time this task has been attempted to run
    retry: {type: Number, default: 0 }, //number of time this task should be re-tried. 0 means only run once.
  
    ////////////////////////////////////////////////////////////////////////////////////////
    // fields set by sca-task 

    status: {type: String, index: true}, //requested, running, failed, stop_requested, stopped, (running_sync), removed, finished
    status_msg: String,

    //resource where the task is currently running (or was)
    resource_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Resource', index: true},

    //resources where task dir exits (where it ran, or synced)
    resource_ids: [ {type: mongoose.Schema.Types.ObjectId, ref: 'Resource'} ],
    
    //environment parameters set in _boot.sh (nobody uses this.. just to make debugging easier)
    _envs: mongoose.Schema.Types.Mixed,

    //list of resources considered while selecting the resource
    _considered: mongoose.Schema.Types.Mixed,
    
    //content of product.json if generated
    //if app creates mutiple datasets, it should contain an array of objects where each object corresponds to each output dataset
    product: mongoose.Schema.Types.Mixed,
 
    //next time sca-task should check this task again (unset to check immediately)
    next_date: {type: Date, index: true},
    
    //time when this task was originally created
    create_date: {type: Date, default: Date.now },
    
    /////////////////////////////////////////////////////////////////////////
    //
    // I wonder if we should deprecate these dates in favor of task events..
    //
    //time when this task was last started (doesn't mean the actually start time of pbs jobs)
    start_date: {type: Date},
    //time when this task was last finished
    finish_date: {type: Date},
    //time when this task was last failed
    fail_date: {type: Date},
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
//
// store status change events for all tasks
//
var taskeventSchema = mongoose.Schema({
    task_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Task', index: true},
    resource_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Resource', index: true},

    user_id: {type: String, index: true}, 
    service: String,
    service_branch: String,

    status: String,
    status_msg: String,

    date: {type: Date, default: Date.now, index: true },
});
exports.Taskevent = mongoose.model('Taskevent', taskeventSchema);

/*
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
*/
