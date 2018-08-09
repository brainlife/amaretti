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
//mongoose.Promise = global.Promise; 

exports.init = function(cb) {
    events.init(err=>{
        if(err) return cb(err);
        mongoose.connect(config.mongodb, {
            //TODO - isn't auto_reconnect set by default?
            server: { auto_reconnect: true, reconnectTries: Number.MAX_VALUE}
        }, function(err) {
            if(err) return cb(err);
            //logger.info("connected to mongo");
            cb();
        });
    });
}

exports.disconnect = function(cb) {
    mongoose.disconnect(err=>{
        events.disconnect(cb);
    });
}

///////////////////////////////////////////////////////////////////////////////////////////////////

//*workflow* instance
var instanceSchema = mongoose.Schema({
    name: String, //name of the workflow (usually used only internally)
    desc: String, //desc of the workflow

    //we use string for IDS - because we might move auth service to mongo db someday..
    user_id: {type: String, index: true}, //user that this workflow instance belongs to

    //(optional) make this instance accessible from all members of this group
    //if this is updated, all task's group_id needs to be updated also
    group_id: {type: Number, index: true}, 

    //store details mainly used by UI
    config: mongoose.Schema.Types.Mixed,

    status: String, //instance status (computed from tasks inside it)

    create_date: {type: Date, default: Date.now },
    update_date: {type: Date, default: Date.now },
});

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
    desc: String, 
    
    type: String, //DEPRECATED... use resource config via resource_id and use the type specified there

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

    user_id: {type: String, index: true}, //sub of user submitted this request
    
    //progress service key for this task
    progress_key: {type: String, index: true}, 

    ////////////////////////////////////////////////////////////////////////////////////////
    // fields that user can set during request

    //workflow instance id
    instance_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Instance', index: true},
    
    //copy of group_id on instance record (should be the same as instance's group_id)
    //this exists to help with access control
    _group_id: {type: Number, index: true}, 

    //github repo
    service: String, // "soichih/sca-service-life"
    service_branch: String, //master by default

    commit_id: String, //git commit id when the task was started
       
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

    //mili-seconds after start_date to stop running job (default to 7 days)
    //note.. this includes time that task is in the queue
    //this mainly exists to prevent jobs from getting stuck running, but also to stop tasks while it's being started.
    max_runtime: { type: Number, default: 1000*3600*24*7},

    //TODO - I should probaly deprecate this. also.. app should handle its own retry if it's expecting things to fail
    run: {type: Number, default: 0 }, //number of time this task has been attempted to run
    retry: {type: Number, default: 0 }, //number of time this task should be re-tried. 0 means only run once.
    nice: Number, //nice-ness of this task can't be negative (except a paid user?)
  
    ////////////////////////////////////////////////////////////////////////////////////////
    // fields set by sca-task 

    status: {type: String, index: true}, 
    //requested,  
    //  all new task should be placed under requested
    //waiting  (trying to deprecate)
    //  requested tasks will be placed on waiting status if any deps are not yet finished
    //running, 
    //failed, 
    //finished
    //stop_requested, 
    //  running job should be placed on stop_requested so that amaretti can stop it 
    //stopped, 
    //(running_sync), 
    //removed, 

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
    //time when this task was last started - including being handled by start_task (doesn't mean the actually start time of pbs jobs)
    start_date: {type: Date},
    //time when this task was last finished
    finish_date: {type: Date},
    //time when this task was last failed
    fail_date: {type: Date},
    //time when this task was last updated (only used by put api?)
    update_date: {type: Date},
    //time when this task was requested (!=create_date if re-requested)
    request_date: {type: Date},
    //date when the task dir should be removed (if not requested or running) - if not set, will be remved after 25 days
    remove_date: Date,

    //experimental.............
    //number of times to tried to request (task will be marked as failed once it reaches certain number)
    request_count: {type: Number, default: 0 },
    
});

taskSchema.post('save', events.task);
taskSchema.post('findOneAndUpdate', events.task);
taskSchema.post('findOneAndRemove', events.task);
taskSchema.post('remove', events.task);

taskSchema.index({name: 'text', desc: 'text'});
taskSchema.index({status: 1, next_date: 1}); 

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

