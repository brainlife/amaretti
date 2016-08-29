'use strict';

var request = require('request');
var fs = require('fs');
var jwt = require('jsonwebtoken');

//update to point to your sca instance
var sca = "https://soichi7.ppa.iu.edu/api";

request.get({
    url: sca+"/wf/resource",
    json: true,
    headers: { 'Authorization': 'Bearer invalid' },
}, function(err, res, body) {
    if(err) throw err;
    console.dir(body);
});

