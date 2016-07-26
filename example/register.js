'use strict';

var request = require('request');
var fs = require('fs');

var sca = "https://test.sca.iu.edu/api";
var jwt = fs.readFileSync('test.sca.jwt', {encoding: 'ascii'}).trim();

//using SCA local username and password
request.post({
    url: sca+"/sca/resource", 
    json: true, 
    headers: { 'Authorization': 'Bearer '+jwt },
    body: {
        type: "pbs",
        resource_id: "karst",
        name: "use foo's karst account",
        config: {
            "username": "hayashis",
            "enc_ssh_private": "hoge123",
            "ssh_public": "my public key"
        },
    }
}, function(err, res, body) {
    if(err) throw err;
    console.dir(body);
});
