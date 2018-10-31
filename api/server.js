//node
const fs = require('fs');
const path = require('path');

//contrib
const express = require('express');
const bodyParser = require('body-parser');
const winston = require('winston');
const expressWinston = require('express-winston');
const compression = require('compression');
const cors = require('cors');

//mine
const config = require('../config');
const logger = new winston.Logger(config.logger.winston);
const db = require('./models');

//init express
const app = express();
app.use(cors());
app.use(compression());

app.disable('etag'); //to speed things up, but I really haven't noticed much difference
app.disable('x-powered-by'); //for better security?

//parse application/json
app.use(bodyParser.json({limit: '2mb'}));  //default is 100kb
app.use(bodyParser.urlencoded({ extended: false }));

app.use(expressWinston.logger(config.logger.winston));

app.use('/', require('./controllers'));

//error handling
app.use(expressWinston.errorLogger(config.logger.winston)); 
app.use(function(err, req, res, next) {
    if(typeof err == "string") err = {message: err};

    //log this error
    logger.info(err);
    if(err.name) switch(err.name) {
    case "UnauthorizedError":
        logger.info(req.headers); //dump headers for debugging purpose..
        break;
    }

    if(err.stack) err.stack = "hidden"; //don't sent call stack to UI - for security reason
    //res.status(err.status || 500); //err.status set to 0?
    res.status(500);
    res.json(err);
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
            logger.info("workflow/api service:%s running on %s:%d in %s mode", process.env.NODE_APP_INSTANCE, host, port, app.settings.env);
        });
    });
}

