#!/usr/bin/node
var request = require('request');
var fs = require('fs');
var jwt = require('jsonwebtoken');

//update to point to your sca instance
var sca = "https://soichi7.ppa.iu.edu/api";

request.post({
    url: sca+"/auth/ldap/auth", 
    json: true,
    body: {username: "hayashis", password: process.env.PASSWORD}
}, function(err, res, body) {
    if(err) throw err;
    console.dir(res.body);
    if(res.statusCode != 200) {
        console.dir(res);
    }
    var token = jwt.decode(body.jwt);
    console.dir(token);
    fs.writeFileSync("/home/hayashis/.sca/keys/cli.jwt", body.jwt);
});

