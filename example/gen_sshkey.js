'use strict';

var request = require('request');
var fs = require('fs');

var sca = "https://test.sca.iu.edu/api";

//register new user
//using SCA local username and password
request.get({
    url: sca+"/sca/resource/gensshkey", 
    json: true, 
}, function(err, res, body) {
    if(err) throw err;
    console.dir(body);
});
