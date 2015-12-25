#!/usr/bin/node
'use strict';

var winston = require('winston');

var config = require('./config/config');
var server = require('./server');

console.log("starting logger...");
winston.add(winston.transports.File, {
    filename: config.logger.api
});
winston.handleExceptions(new winston.transports.File({
    filename: config.logger.exception
}));

console.log("starting web server...");
server.start();

console.log("waiting for incoming connections...");
