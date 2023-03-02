'use strict';

const amqp = require('amqp'); //maybe I should switch to amqplib?

//mine
const config = require('../config');
const db = require('./models');

let conn;
let connected = false;
let amaretti_ex;

//deprecate these for amaretti_ex
let task_ex;
let instance_ex;
let resource_ex;

exports.init = function(cb) {
    if(!config.events) {
        console.warn("events configuration missing - won't publish to amqp");
        return cb();
    }

    console.log("connecting to amqp");
    conn = amqp.createConnection(config.events.amqp); //reconnect by default
    conn.on('ready', function() {
        connected = true;
        console.log("amqp connection ready.. creating exchanges");

        conn.exchange("amaretti",
            {autoDelete: false, durable: true, type: 'topic', confirm: true}, function(ex) {
            amaretti_ex = ex;
        });

        /////////////////////////////////////////////////////////////
        //
        //deprecated by amaretti_ex
        conn.exchange(config.events.exchange+".task", 
            {autoDelete: false, durable: true, type: 'topic', confirm: true}, function(ex) {
            task_ex = ex;
        });
        conn.exchange(config.events.exchange+".instance", 
            {autoDelete: false, durable: true, type: 'topic', confirm: true}, function(ex) {
            instance_ex = ex;
        });
        conn.exchange(config.events.exchange+".resource", 
            {autoDelete: false, durable: true, type: 'topic', confirm: true}, function(ex) {
            resource_ex = ex;
        });
        //
        /////////////////////////////////////////////////////////////

        //I am not sure if ready event fires every time it reconnects.. (find out!) 
        //so let's clear cb() once I call it
        if(cb) {
            cb();
            cb = null;
        }
    });
    conn.on('error', console.error);
}

exports.disconnect = function(cb) {
    if(!connected) {
        if(cb) cb("not connected");
        return;
    }

    //https://github.com/postwait/node-amqp/issues/462
    console.log("disconnecting from amqp.. (amqp.discnnect()  oesn't release event loop..)");
    conn.setImplOptions({reconnect: false}); //noeffect?
    conn.disconnect();
    connected = false;
    if(cb) cb();
}

function publish_or_log(ex, key, msg, cb) {
    if(!ex || !connected) {
        //if not connected, output to stdout..
        console.log("----------- no amqp ------------------", key);
        console.log(JSON.stringify(msg, null, 4));
        if(cb) cb();
    } else {
        ex.publish(key, msg, {}, cb);
    }
}

exports.task = function(task) {

    //get previous task status to see if status changed
    db.Taskevent.findOne({task_id: task._id}, 'status', {sort: {'date': -1}}).lean().exec((err, lastevent)=>{
        if(err) return console.error(err);
        let status_changed = false;
        if(!lastevent || lastevent.status != task.status) status_changed = true;
        if(status_changed) {
            //status changed! store event
            var taskevent = new db.Taskevent({
                task_id: task._id, 
                resource_id: task.resource_id,
                _group_id: task._group_id,

                user_id: task.user_id, 
                status: task.status, 
                status_msg: task.status_msg, 
                service: task.service, 
                service_branch: task.service_branch,  //might deprecate..
            });
            taskevent.save();
        }

        //some fields are populated (foreign keys are de-referenced)
        //to normalize the field type, let's load the record from database
        //TODO - can't I just test to see if _id exists for those field and replace them with it?
        db.Task.findById(task._id).lean().exec((err, _task)=>{
            let key = task.instance_id+"."+task._id;
            publish_or_log(task_ex, key, _task);
        });
    });
}

exports.instance = function(instance) {
    //var key = instance.user_id+"."+instance._id;
    let group_id = instance.group_id||"na";
    let key = group_id+"."+instance._id;
    publish_or_log(instance_ex, key, instance);
}

//right now nobody receives resource update event as far as I know..
exports.resource = function(resource) {
    if(!resource._id) return; //can't post event if _id isn't set (for new document save"?)
    let key = resource._id.toString();
    publish_or_log(resource_ex, key, {
        _id: resource._id,
        active: resource.active,
        name: resource.name,
        desc: resource.desc,

        status: resource.status,
        status_msg: resource.status_msg,
        status_update: resource.status_update,
    });
}

exports.publish = (key, message, cb)=>{
    message.timestamp = (new Date().getTime())/1000; //it's crazy that amqp doesn't set this?
    publish_or_log(amaretti_ex, key, message, cb);
}

