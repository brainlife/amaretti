'use strict';

const amqp = require('amqp');
const winston = require('winston');

//mine
const config = require('../config');
const logger = new winston.Logger(config.logger.winston);

var connected = false;
var task_ex = null;
var instance_ex = null;
//var resource_ex = null;
if(config.events) {
    logger.info("attempting to connect to amqp..");
    var conn = amqp.createConnection(config.events.amqp, {reconnectBackoffTime: 1000*10});
    conn.on('ready', function() {
        connected = true;
        logger.info("amqp connection ready.. creating exchanges");

        conn.exchange(config.events.exchange+".task", 
            {autoDelete: false, durable: true, type: 'topic', confirm: true}, function(ex) {
            task_ex = ex;
        });
        conn.exchange(config.events.exchange+".instance", 
            {autoDelete: false, durable: true, type: 'topic', confirm: true}, function(ex) {
            instance_ex = ex;
        });
    });
    conn.on('error', function(err) {
        logger.error("amqp connection error");
        logger.error(err);
        connected = false;
    });
} else {
    logger.info("events configuration missing - won't publish to amqp");
}

function publish_or_log(ex, key, msg) {
    if(!ex || !connected) {
        //if not connected, output to stdout..
        logger.info(key);
        logger.info(msg);
    } else {
        ex.publish(key, msg, {});
    }
}

exports.task = function(task) {
    var key = task.user_id+"."+task.instance_id+"."+task._id;
    publish_or_log(task_ex, key, task);
}

exports.instance = function(instance) {
    var key = instance.user_id+"."+instance.instance_id;
    publish_or_log(instance_ex, key, instance);
}


