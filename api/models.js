'use strict';

//contrib
const mongoose = require('mongoose');
const winston = require('winston');

//mine
const config = require('../config');
const logger = winston.createLogger(config.logger.winston);
const events = require('./events');

exports.init = async function(cb, connectEvent = true) {
    if(connectEvent) {
        console.log("connecting to amqp/events");
        try {
            await events.init();
        } catch (err) {
            return cb(err);
        }
    }
    
    console.log("connecting to mongodb");
    mongoose.connect(config.mongodb, {
        //writeConcern: majority slows down things.. let's just read/write
        //from primary only for now..
        /*
        //TODO - move to config
        readPreference: 'nearest',
        readConcern: {
            //prevents read to grab stale data from secondary
            //requires writeConcern to be set to "majority" also.
            level: 'majority',
        },
        writeConcern: {
            w: 'majority',
        },
        */
        useNewUrlParser: true,
        useUnifiedTopology: true,
    }, cb);
}

exports.disconnect = function(cb) {
    console.log("disconnecting mongo");
    mongoose.disconnect(err=>{
        if(err) throw err;
        if(events.connected) {
            console.log("disconnecting amqp/events");
            events.disconnect(cb);
        }
    });
}

///////////////////////////////////////////////////////////////////////////////////////////////////

//*workflow* instance
var instanceSchema = mongoose.Schema({
    name: String, //name of the workflow (usually used only internally)
    desc: String, //desc of the workflow

    //we use string for IDS - because we might move auth service to mongo db someday..
    user_id: String, //user that this workflow instance belongs to

    //(optional) make this instance accessible from all members of this group
    //TODO if this is updated, all task's _group_id needs to be updated also
    //not set if this instance is only used for the specific user for uploading
    group_id: Number,

    //store details mainly used by UI
    config: mongoose.Schema.Types.Mixed,

    //deprecated... let's just focus on task status
    status: {type: String, default: "empty" }, //instance status (computed from tasks inside it)

    create_date: {type: Date, default: Date.now },
    update_date: {type: Date, default: Date.now },
});

instanceSchema.index({name: 1, user_id: 1, group_id: 1, _id: 1});
instanceSchema.index({"config.brainlife": 1, "group_id": 1, "status": 1, "user_id": 1 });

/* instance events hooks are handled manually so that I can do better control
instanceSchema.post('save', events.instance);
instanceSchema.post('findOneAndUpdate', events.instance);
instanceSchema.post('findOneAndRemove', events.instance);
instanceSchema.post('remove', events.instance);
*/

exports.Instance = mongoose.model('Instance', instanceSchema);

///////////////////////////////////////////////////////////////////////////////////////////

var resourceSchema = mongoose.Schema({

    //sub of the person registered 
    user_id: {type: String, index: true}, 

    //subs of users who should have administrative access for this resource
    admins: [String],

    active: {type: Boolean, default: true},
    name: String, 
    //desc: String, //desc is stored under config.desc for some reason
    avatar: String,

    /*
    @misc{https://doi.org/10.25663/bl.p.3,
      doi = {10.25663/BL.P.3},
      url = {https://brainlife.io/pub/5a0f0fad2c214c9ba8624376},
      author = {Hayashi, Soichi and Avesani, Paolo and Pestilli, Franco},
      keywords = {Neuroimaging, Connectomics, White matter, Network science, Tractography Matching, Machine learning, Web services, open science, reproducibility},
      title = {Open Diffusion Data Derivatives},
      publisher = {brainlife.io},
      year = {2017}
    }

    @misc{http://dx.doi.org/10.1145/2792745.2792774
      doi = {10.1145/2792745.2792774},
      author = {Stewart, C.A., Cockerill, T.M., Foster, I., Hancock, D., Merchant, N., Skidmore, E., Stanzione, D., Taylor, J., Tuecke, S., Turner, G., Vaughn, M., and Gaffney, N.I.},
      title = {Jetstream: a self-provisioned, scalable science and engineering cloud environment},
      publisher = {In Proceedings of the 2015 XSEDE Conference: Scientific Advancements Enabled by Enhanced Cyberinfrastructure. St. Louis, Missouri.  ACM: 2792774},
      year = {2015},
      pages = {1--8}
    }  

    */
    //https://kb.iu.edu/d/anwt
    //https://jetstream-cloud.org/research/citing-jetstream.php
    citation: String, //bibtex citation string to cite this resource 
    
    //DEPRECATED.. all resources are now just ssh
    //type: String, //DEPRECATED... use resource config via resource_id and use the type specified there
    //resource_id: String, //like sda, bigred2 (resource base id..)

    config: mongoose.Schema.Types.Mixed,

    envs: mongoose.Schema.Types.Mixed, //envs to inject for service execution (like HPSS_BEHIND_FIREWALL)

    gids: [{type: Number}], //if set, these set of group can access this resource (only admin can set it)

    //current resource status
    status: String,
    status_msg: String,
    status_update: Date, //update_date is for updating the resource config.. status_update is the date of last status check
    lastok_date: Date, //date which status was last ok... used to auto-deactivate if status remains non-ok for long period of time

    //taskevent stats
    stats: {
        recent_job_counts: [], //histogram of job counts
        total: mongoose.Schema.Types.Mixed, //task status counts keyed by status name
        services: mongoose.Schema.Types.Mixed, //task status counts keyed by service name, then status name
        projects: mongoose.Schema.Types.Mixed, //task sound and total walltime grouped by _group_id (project id)
    },

    create_date: {type: Date, default: Date.now },
    update_date: {type: Date, default: Date.now },
});
resourceSchema.post('save', events.resource);
resourceSchema.post('findOneAndUpdate', events.resource);
resourceSchema.post('findOneAndRemove', events.resource);
resourceSchema.post('remove', events.resource);
//resourceSchema.index({active: 1, status: 1, user_id: 1, gids: 1}); //for resource select
exports.Resource = mongoose.model('Resource', resourceSchema);

///////////////////////////////////////////////////////////////////////////////////////////

var taskSchema = mongoose.Schema({

    //sub of user submitted this request
    //user_id: {type: String, index: true},  //indexStats shows it's not used
    user_id: String,

    //cache of req.user.gids at the time of task request.
    //used by task handler to recreate the req.user to query resources that task can use to run.
    //it can be re-queries from auth service, but this reduces the amount of auth service hit
    gids: [{type: Number}], 
    
    //copy of group_id on instance record (should be the same as instance's group_id)
    _group_id: {type: Number, index: true}, 

    ////////////////////////////////////////////////////////////////////////////////////////
    // fields that user can set during request

    //workflow instance id
    instance_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Instance', index: true},
    //github repo
    service: String, // "soichih/sca-service-life"
    service_branch: String, //master/main by default
    locked: Boolean, //if locked, the task can not be executed again (for app-noop let user upload data but not execute afterward)

    commit_id: String, //git commit id when the task was started
       
    //TEXT INDEX field (below) to be searchable with text search
    name: String, 
    desc: String,  //TODO who uses this?
  
    //resource to be selected if multiple resource is available and score ties
    preferred_resource_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Resource'},

    //only admin can set this field
    //task will be submitted on the same resource that the follow_task_id has run on (resource_id)
    //This can be used to run validator and other finalization tasks.
    follow_task_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Task'},

    //object containing details for this task (passed by user)
    config: mongoose.Schema.Types.Mixed, 

    //(deprecate this in favor of deps_config) task dependencies required to run the service 
    deps: [ {type: mongoose.Schema.Types.ObjectId, ref: 'Task', index: true} ],
    
    //extra task dependency config
    deps_config: [ {
        task: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', index: true },
        //subdirs containing required data (rsync will only sync these subdirs if specified
        subdirs: {
            type: [String], 
            default: undefined,
        }
    } ], 

    //resource dependencies..  (for hpss, it will copy the heytab)
    //resource_deps: [ {type: mongoose.Schema.Types.ObjectId, ref: 'Resource'} ],

    //mili-seconds after start_date to stop running job (default to 7 days)
    //note.. this includes time that task is in the batch queue (don't set it too short!)
    //this mainly exists to prevent jobs from getting stuck running, but also to stop tasks while it's being started.
    max_runtime: { type: Number, default: 1000*3600*24*7},

    //TODO - I should probaly deprecate this. also.. app should handle its own retry if it's expecting things to fail
    run: {type: Number, default: 0 }, //number of time this task has been attempted to run
    
    //retry: {type: Number, default: 0 }, //number of time this task should be re-tried. 0 means only run once.

    nice: Number, //nice-ness of this task can't be negative (except a paid user?)
  
    ////////////////////////////////////////////////////////////////////////////////////////
    // fields set by sca-task 

    status: {type: String, index: true}, 
    //requested,  (all new task should be placed under requested)
    //running, 
    //failed, 
    //finished
    //stop_requested, (running job should be placed on stop_requested so that amaretti can stop it)
    //stopped, 
    //(running_sync), 
    //removed, 

    status_msg: String,

    //resource where the task is currently running (or was). It gets cleared if rerun
    //resource_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Resource', index: true}, //accesses.ops is 0
    resource_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Resource' },

    //resources where task dir exits (where it ran, or synced)
    resource_ids: [ {type: mongoose.Schema.Types.ObjectId, ref: 'Resource'} ],
    
    //environment parameters set in _boot.sh (nobody uses this.. just to make debugging easier)
    _envs: mongoose.Schema.Types.Mixed,

    //list of resources considered while selecting the resource
    _considered: mongoose.Schema.Types.Mixed,
    
    /*
    //TODO - deprecated by taskproduct
    //content of product.json if generated
    //if app creates mutiple datasets, it should contain an array of objects where each object corresponds to each output dataset
    product: mongoose.Schema.Types.Mixed,
    */
 
    //next time sca-task should check this task again (unset to check immediately)
    //next_date: {type: Date, index: true}, //indexStats shows it's not used
    next_date: Date,
    
    //time when this task was originally created
    create_date: {type: Date, default: Date.now },
    
    /////////////////////////////////////////////////////////////////////////
    //
    // I wonder if we should deprecate these dates in favor of task events..
    //
    //time when this task was last started - including being handled by start_task (doesn't mean the actually start time of pbs jobs)
    start_date: Date,

    finish_date: Date, //time when this task was last finished
    runtime: Number, //finish_date - start_date (in ms) - set when finish_date is set

    fail_date: Date, //time when this task was last failed
    update_date: Date, //time when this task was last updated (only used by put api?)
    request_date: Date, //time when this task was requested (!=create_date if re-requested)
    remove_date: Date, //date when the task dir should be removed (if not requested or running) - if not set, will be remved after 25 days

    handle_date: {type: Date, default: Date.now }, //last time this task was handled by task handler

    //experimental.............
    //number of times to tried to request (task will be marked as failed once it reaches certain number)
    request_count: {type: Number, default: 0 },
}, {minimize: false}); //don't let empty config({}) disappeare

taskSchema.post('save', events.task);
taskSchema.post('findOneAndUpdate', events.task);
taskSchema.post('findOneAndRemove', events.task);
taskSchema.post('remove', events.task);

taskSchema.index({status: 1, _group_id: 1});  //counting number of tasks per group
taskSchema.index({user_id: 1, _group_id: 1});  //for rule hanler to find task that belongs to a user
taskSchema.index({'config._outputs.id': 1});  //to look for app-stage that staged specific dataset (dataset.vue) 
//taskSchema.index({project: 1, removed: 1}); //for task aggregate $math and group by subject/datatype
//taskSchema.index({ "_group_id": 1, "finish_date": 1, "resource_id": 1, "service": 1, "start_date": 1 }); //total walltime
taskSchema.index({resource_id: 1, status: 1, start_date: 1});  //index to count running / requested tasks for each resource
//taskSchema.index({resource_id: 1, status: 1, service: 1});

//taskSchema.index({resource_id: 1, status: 1, create_date: 1}); //look for recent task

taskSchema.index({status: 1,  resource_ids: 1, next_date: 1});  //find task to be removed when all resources gets removed
//taskSchema.index({service: 1, status: 1, user_id: 1, create_date: 1, }); //active user count
taskSchema.index({service: 1, status: 1, "config._tid": 1, user_id: 1, _group_id: 1, create_date: -1}); //dashboard task list
//taskSchema.index({follow_task_id: 1 });
taskSchema.index({finish_date: 1, "config._app": 1, follow_task_id: 1 }); //sample tasks for an app

exports.Task = mongoose.model('Task', taskSchema);

///////////////////////////////////////////////////////////////////////////////////////////////////

var taskproductSchema = mongoose.Schema({
    task_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Task', index: true},
    product: mongoose.Schema.Types.Mixed,
});
exports.Taskproduct = mongoose.model('Taskproduct', taskproductSchema);

///////////////////////////////////////////////////////////////////////////////////////////////////
//
// store status change events for all tasks
//
var taskeventSchema = mongoose.Schema({
    task_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Task', index: true},
    resource_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Resource'},
    _group_id: String, //aka project (recently added)

    user_id: String,
    service: String,
    service_branch: String,

    status: String,
    status_msg: String,

    date: {type: Date, default: Date.now },
});
taskeventSchema.index({ "service": 1, "status": 1, "date": -1 });//search recently finished
exports.Taskevent = mongoose.model('Taskevent', taskeventSchema);

///////////////////////////////////////////////////////////////////////////////////////////////////
//
// store service info
//
var serviceinfoSchema = mongoose.Schema({
    service: {type: String, index: true}, 

    status: String,
    status_msg: String,

    counts: new mongoose.Schema({
        failed: Number,
        finished: Number,
        stop_requested: Number,
        stopoped: Number,
        running_sync: Number,
        running: Number,
        requested: Number,
        removed: Number,
    }),

    /* //deprecated by graphite proxy
    hist: new mongoose.Schema({
        failed: [Number],
        finished: [Number],
        //stop_requested: Number,
        //stopoped: Number,
        running_sync: [Number],
        running: [Number],
        requested: [Number],
        removed: [Number],
    }),
    */

    //number of unique users who ran this service
    users: Number,

    //object keyed by sub and counts of finished and failed tasks
    user: mongoose.Schema.Types.Mixed,

    runtime_mean: Number,
    runtime_std: Number,
    success_rate: Number,

    readme_status: String, //I think I am going to deprecate this (by status/status_msg)
});
exports.Serviceinfo = mongoose.model('Serviceinfo', serviceinfoSchema);

