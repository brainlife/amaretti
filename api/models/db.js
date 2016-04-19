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
        console.log("connected to mongo");
        cb();
    });
}
exports.disconnect = function(cb) {
    mongoose.disconnect(cb);
}

///////////////////////////////////////////////////////////////////////////////////////////////////

//workflow instance
var instanceSchema = mongoose.Schema({

    workflow_id: String, //"freesurfer"

    name: String, //name of the workflow
    desc: String, //desc of the workflow

    //user that this workflow instance belongs to
    user_id: {type: String, index: true}, 

    config: mongoose.Schema.Types.Mixed,

    create_date: {type: Date, default: Date.now },
    update_date: {type: Date, default: Date.now },
});
instanceSchema.pre('update', function(next) {
    this.update_date = new Date();
    next();
});
exports.Instance = mongoose.model('Instance', instanceSchema);

///////////////////////////////////////////////////////////////////////////////////////////////////

var resourceSchema = mongoose.Schema({
    ////////////////////////////////////////////////
    //key
    user_id: {type: String, index: true}, 
    type: String, //like hpss, pbs, 
    resource_id: String, //like sda, bigred2
    //
    ////////////////////////////////////////////////

    status: String,
    status_msg: String,
    status_update: Date,

    name: String, 
    config: mongoose.Schema.Types.Mixed,
    salts: mongoose.Schema.Types.Mixed, //salts used to encrypt fields in config (that starts with enc_)

    create_date: {type: Date, default: Date.now },
    update_date: {type: Date, default: Date.now },
});

//mongoose's pre/post are just too fragile.. it gets call on some and not on others.. (like findOneAndUpdate)
//I prefer doing this manually anyway, because it will be more visible 
resourceSchema.pre('update', function(next) {
    //this._update.$set.update_date = new Date();
    this.update_date = new Date();
    next();
});
exports.Resource = mongoose.model('Resource', resourceSchema);

///////////////////////////////////////////////////////////////////////////////////////////////////

var taskSchema = mongoose.Schema({

    user_id: String, //sub of user submitted this request

    instance_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Instance'},
    service_id: String,
    
    //resource where the service was executed (not set if it's not yet run)
    resource_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Resource'},
    
    //environment parameters set in _boot.sh (nobody uses this.. just to make debugging easier)
    _envs: mongoose.Schema.Types.Mixed,
    
    //content of products.json once generated
    products: mongoose.Schema.Types.Mixed,

    progress_key: {type: String, index: true}, 

    status: String, 
    status_msg: String,
    status_update: Date,

    //if this document is handled by sca-task, this will be set to hostname, pid, timestamp of the sca-task
    _handled: mongoose.Schema.Types.Mixed,
    
    //object containing details for this task
    config: mongoose.Schema.Types.Mixed, 

    //task dependencies required to run the service 
    deps: [ {type: mongoose.Schema.Types.ObjectId, ref: 'Task'} ],

    //list of resource where the output directory is synchronized (TODO - not sure if I will use this or not)
    //resources: [ {type: mongoose.Schema.Types.ObjectId, ref: 'Resource'} ],

    create_date: {type: Date, default: Date.now },
    update_date: {type: Date, default: Date.now },
});
taskSchema.pre('update', function(next) {
    this.update_date = new Date();
    next();
});

exports.Task = mongoose.model('Task', taskSchema);

///////////////////////////////////////////////////////////////////////////////////////////////////

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



