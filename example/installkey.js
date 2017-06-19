#!/usr/bin/env node
'use strict';

var request = require('request');
var fs = require('fs');

var sca = "https://test.sca.iu.edu/api";

console.log(process.env.TEST);

request.post({
    url: sca+"/wf/resource/installsshkey", 
    json: true, 
    body: {
        username: process.env.USER,
        password: process.env.PASSWORD,
        host: "karst.uits.iu.edu",

        comment: "key used by sca to access karst \"quote\"",
        pubkey: "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDmVF2IWVhsehiY+l2wJJxtREUIZLGIExnTI7c1w98HB1pmwaIkOKHTEGgGPK6ktqGbFMz1qpMi8VlOlpcGo7BZ7ptlbknxk43rFfDtxyU++ZZcfKJXSMo1/F8XZaqdETtCsJ2IQ59b3tlF0gVRcY24dLDWMxDW/s4q64tanHpwa1zRD57pnsGO+UO4/WykTvG9LaoMVGEb8FThB8Wh1ntV89qWIACb1ArrKT9Z5yn8RE22DKysh7Cze5Lbq9yl/mzHf5gVrTx5wPFuQHwQ2KUt1Jk0Ky4NS8GY2CjYALq4/G9kOxvf3YK2oIsL31WA2D79k5g4uPdJ8aoMGWu7hO5z test",
    }
}, function(err, res, body) {
    if(err) throw err;
    console.dir(body);
});
