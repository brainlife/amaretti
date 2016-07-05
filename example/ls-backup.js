'use strict';

var request = require('request');
var fs = require('fs');
var os = require('os');

var sca = "https://soichi7.ppa.iu.edu/api";
var jwt = fs.readFileSync('/home/hayashis/.sca/keys/cli.jwt', {encoding: 'ascii'}).trim();

var instance_id = "5716ae31d43e9a2e1649e927";

request.get({
    url: sca+"/wf/task",
    json: true,
    headers: { 'Authorization': 'Bearer '+jwt },
    qs: {
        find: JSON.stringify({
            status: "finished", 
            name: "backup",
            //service: "soichih/sca-service-hpss", 
            //"config.info.tags": {$in: ["test"]},
            instance_id: instance_id
        })
    }
}, function(err, res, tasks) {
    if(err) return cb(err);
    if(res.statusCode != "200") return cb("request failed with code:"+res.statusCode);
    console.log(JSON.stringify(tasks, null, 4));
});

