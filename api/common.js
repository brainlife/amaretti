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

exports.getworkdir = function(workflow_id, resource) {
    var detail = config.resources[resource.resource_id];
    var template = detail.workdir;
    var workdir = template
        .replace("__username__", resource.config.username)
        .replace("__workflowid__", workflow_id);
    return workdir; 
}
exports.gettaskdir = function(workflow_id, task_id, resource) {
    var workdir = exports.getworkdir(workflow_id, resource);
    return workdir+"/"+task_id;
}

