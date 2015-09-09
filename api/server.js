'use strict';

var fs = require('fs');

var express = require('express');
var jwt = require('express-jwt');
var bodyParser = require('body-parser');

var config = require('./config/config');

//var scaauth = require('sca-auth');
//var scaprofile = require('sca-profile');

//scaauth.init(config.auth);
//scaprofile.init(config.profile);

var app = express();

//var jwtac = jwt({secret: config.auth.public_key});

app.use(bodyParser.json()); //parse application/json
app.use(config.logger.express);

app.get('/health', function(req, res) {
    res.json({status: 'running'});
});

//app.use('/auth', scaauth.router);
//app.use('/profile', scaprofile.router);
app.use(function(req, res, next) {
    var err = new Error('Not Found');
    err.status = 404;
    next(err);
});
app.use(function(err, req, res, next) {
    console.dir(err);
    res.status(err.status || 500);
    res.json({message: err.message});
});

function start() {
    var port = process.env.PORT || '8080';
    app.listen(port);
    console.log("Express server listening on port %d in %s mode", port, app.settings.env);
}

exports.start = start;
exports.app = app;
