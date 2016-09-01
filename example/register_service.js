#!/usr/bin/env node
'use strict';

var request = require('request');
var fs = require('fs');

var jwt = fs.readFileSync(__dirname+'/../config/sca.jwt', {encoding: 'ascii'}).trim();

//using SCA local username and password
request.post({
    url: "https://soichi7.ppa.iu.edu/api/wf/service",

    json: true,
    headers: { 'Authorization': 'Bearer '+jwt },
    body: {
        //giturl: "https://github.com/soichih/sca-service-noop"
        giturl: "https://github.com/soichih/sca-product-onere-build"
    }
}, function(err, res, body) {
    if(err) throw err;
    console.dir(body);
});

