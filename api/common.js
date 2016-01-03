'use strict';

//node
var fs = require('fs');
var path = require('path');

//contrib
var winston = require('winston');
var async = require('async');

//mine
var config = require('./config');
var logger = new winston.Logger(config.logger.winston);
var db = require('./models/db');
var progress = require('./progress');

exports.getworkdir = function(task, resource) {
    var detail = config.resources[resource.resource_id];
    var template = detail.workdir;
    var workdir = template
        .replace("__username__", resource.config.username)
        .replace("__workflowid__", task.workflow_id);
    return workdir; 
}
exports.gettaskdir = function(task, resource) {
    var workdir = exports.getworkdir(task, resource);
    return workdir+"/"+task._id;
}
