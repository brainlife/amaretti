'use strict';

var request = require('request');
var fs = require('fs');
var jwt = require('jsonwebtoken');

//update to point to your sca instance
var sca = "https://soichi7.ppa.iu.edu/api";
var jwt = fs.readFileSync('/home/hayashis/.sca/keys/cli.jwt', {encoding: 'ascii'}).trim();

request.get({
    url: sca+"/wf/resource",
    json: true,
    headers: { 'Authorization': 'Bearer '+jwt },
}, function(err, res, body) {
    if(err) throw err;
    console.dir(body);
});

