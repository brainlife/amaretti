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

var workflowSchema = mongoose.Schema({

    //workflow id (like "freesurfer")
    type_id: String,

    //user that this workflow instance belongs to
    user_id: {type: String, index: true}, 

    config: mongoose.Schema.Types.Mixed,
    /*
    steps: [ mongoose.Schema({
        service_id: String,
        name: String,  //not sure if I will ever use this
        config: mongoose.Schema.Types.Mixed,

        tasks: [ {type: mongoose.Schema.Types.ObjectId, ref: 'Task'}],
        //products: [ {type: mongoose.Schema.Types.ObjectId, ref: 'Product'}],

        //not sure how useful / accurate these will be..
        create_date: {type: Date, default: Date.now },
        //update_date: {type: Date, default: Date.now },
    }) ] ,
    */

    create_date: {type: Date, default: Date.now },
    update_date: {type: Date, default: Date.now },
});
workflowSchema.pre('update', function(next) {
    this.update_date = new Date();
    next();
});
exports.Workflow = mongoose.model('Workflow', workflowSchema);

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
    ///////////////////////////////////////////////////////////////////////////////////////////////
    //important fields
    //workflow_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Workflow'},
    instance_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Workflow'},
    //step_idx: Number, //index of step within workflow
    user_id: String, //sub of user submitted this request
    //
    //////////////////////////////////////////////////////////////////////////////////////////////

    //name: String,
    service_id: String,

    progress_key: {type: String, index: true}, 

    status: String, 
    status_msg: String,
    status_update: Date,

    //if this document is handled by sca-task, this will be set to hostname, pid, timestamp of the sca-task
    _handled: mongoose.Schema.Types.Mixed,

    resource_id: mongoose.Schema.Types.ObjectId,
    
    //object containing details for this task
    config: mongoose.Schema.Types.Mixed, 

    //task dependencies required to run the service 
    deps: [ {type: mongoose.Schema.Types.ObjectId, ref: 'Task'} ],

    products: mongoose.Schema.Types.Mixed,

    create_date: {type: Date, default: Date.now },
    update_date: {type: Date, default: Date.now },
});
taskSchema.pre('update', function(next) {
    this.update_date = new Date();
    next();
});

exports.Task = mongoose.model('Task', taskSchema);



