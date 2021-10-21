//node
const fs = require('fs');
const path = require('path');

//contrib
const express = require('express');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const compression = require('compression');
const cors = require('cors');

const expressJwt = require('express-jwt');

//mine
const config = require('../config');
const db = require('./models');

//init express
const app = express();
app.use(cors());
app.use(morgan('dev'));
app.use(compression());

app.disable('etag'); //to speed things up, but I really haven't noticed much difference
app.disable('x-powered-by'); //for better security?

//parse application/json
app.use(bodyParser.json({limit: '2mb'}));  //default is 100kb
app.use(bodyParser.urlencoded({ extended: false }));

app.use('/', require('./controllers'));

//error handling
app.use(function(err, req, res, next) {
    if(typeof err == "string") err = {message: err};
    if(err instanceof Error) err = {message: err.toString()};

    //log this error
    console.log(err);
    if(err.name) switch(err.name) {
    case "UnauthorizedError":
        console.log(req.headers); //dump headers for debugging purpose..
        break;
    }

    if(err.stack) err.stack = "hidden"; //don't sent call stack to UI - for security reason
    res.status(500);
    res.json(err);
});

process.on('uncaughtException', function (err) {
    //TODO report this to somewhere!
    console.error((new Date).toUTCString() + ' uncaughtException:'+ err.message)
    console.error(err.stack)
});

exports.app = app;
exports.start = function(cb) {
    var port = process.env.PORT || config.express.port || '8081';
    var host = process.env.HOST || config.express.host || 'localhost';
    db.init(function(err) {
        if(err) return cb(err);
        app.listen(port, host, function() {
            console.log("workflow/api service:%s running on %s:%d in %s mode", process.pid, host, port, app.settings.env);
        });
    });
}

