#!/usr/bin/node

//node
var fs = require('fs');
var path = require('path');

//contrib
var express = require('express');
var bodyParser = require('body-parser');
var winston = require('winston');
var expressWinston = require('express-winston');
var compression = require('compression');

//mine
var config = require('./config');
var logger = new winston.Logger(config.logger.winston);
var db = require('./models/db');
//var migration = require('./migration');
//var common = require('./common');

//init express
var app = express();
app.use(compression());

//parse application/json
app.use(bodyParser.json()); 
app.use(bodyParser.urlencoded({ extended: false }));

app.use(expressWinston.logger(config.logger.winston));

app.use('/', require('./controllers'));
app.use('/product', require('./products'));
app.use('/service', require('./services'));

//error handling
app.use(expressWinston.errorLogger(config.logger.winston)); 
app.use(function(err, req, res, next) {
    logger.error(err);
    if(err.stack) logger.error(err.stack);
    res.status(err.status || 500);
    var o = {};
    if(err.message) o.message = err.message;
    //if(err.code) o.message = "Error Code: "+err.code;
    //if(config.debug) o.stack = err.stack;
    res.json(o);
});

process.on('uncaughtException', function (err) {
    //TODO report this to somewhere!
    logger.error((new Date).toUTCString() + ' uncaughtException:', err.message)
    logger.error(err.stack)
});

exports.app = app;
exports.start = function(cb) {
    var port = process.env.PORT || config.express.port || '8081';
    var host = process.env.HOST || config.express.host || 'localhost';
    db.init(function(err) {
        if(err) return cb(err);
        app.listen(port, host, function() {
            logger.info("sca webui/api service running on %s:%d in %s mode", host, port, app.settings.env);
        });
    });
}

