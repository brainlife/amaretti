'use strict';

const amqp = require('amqp');
const winston = require('winston');

//mine
const config = require('../config');
const logger = new winston.Logger(config.logger.winston);

var event_ex = null;
if(config.events) {
    var conn = amqp.createConnection(config.events.amqp, {reconnectBackoffTime: 1000*10});
    conn.on('ready', function() {
        //logger.info("amqp connection ready");
        conn.exchange(config.events.exchange, {autoDelete: false, durable: true, type: 'topic', confirm: true}, function(ex) {
            event_ex = ex;
            logger.info("amqp connection/exchange ready");
        });
    });
    conn.on('error', function(err) {
        logger.error("amqp connection error");
        logger.error(err);
        event_ex = null; //should I?
    });
} else {
    logger.info("events configuration missing - won't publish to amqp");
}

function publish(key, msg) {
    if(!event_ex) {
        //if not connected, output to stdout..
        logger.info(key);
        logger.info(msg.toString());
    } else {
        event_ex.publish(key, msg, {});
    }
}

exports.task = function(task) {
    var key = "task."+task.instance_id+"."+task._id;
    publish(key, task);
}

/*
exports.create = function(doc) {
    var key = "task.create."+task.instance_id+"."+task._id;
    publish(key, task);
}

exports.remove = function(doc) {
    var key = "task.remove."+task.instance_id+"."+task._id;
    publish(key, task);
}
*/
