'use strict';

var request = require('request');
var fs = require('fs');

var sca = "https://test.sca.iu.edu/api";
var jwt = fs.readFileSync('stardock.jwt', {encoding: 'ascii'}).trim();

request.post({
    url: sca+"/sca/task",
    json: true,
    headers: { 'Authorization': 'Bearer '+jwt },
    body: {
        instance_id: "5759b6aae2d20c0276f09d27",
        service: "soichih/sca-service-hpss",
        config: {
            "param1": "abc",
        },
    }
}, function(err, res, body) {
    if(err) throw err;
    console.dir(res.statusCode + " "+res.statusMessage);
    console.dir(body);
});


