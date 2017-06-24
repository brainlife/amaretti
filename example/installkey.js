#!/usr/bin/env node
'use strict';

var request = require('request');
var fs = require('fs');

var sca = "https://soichi7.ppa.iu.edu/api";

console.log(process.env.TEST);

request.post({
    url: sca+"/wf/resource/installsshkey", 
    json: true, 
    body: {
        username: process.env.USER,
        password: process.env.PASSWORD,
        host: "karst.uits.iu.edu",

        //comment: "key used by sca to access karst \"quote\"",
        //comment: "comment \x22 test",
        //comment: "comment \u0000 test",
        comment: "",
        pubkey: "ssh-teeeeeeeeeeeeeeeeeeeesssssssssssssss  \x0a  ssssssssttttttttttttttttttttttttt",
    }
}, function(err, res, body) {
    if(err) throw err;
    console.dir(body);
});
