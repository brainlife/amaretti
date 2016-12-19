'use strict';

var request = require('request');
var fs = require('fs');

//var sca = "https://test.sca.iu.edu/api";
//var jwt = fs.readFileSync('stardock.jwt', {encoding: 'ascii'}).trim();
var sca = "https://soichi7.ppa.iu.edu/api";
var jwt = fs.readFileSync('/home/hayashis/.sca/keys/cli.jwt', {encoding: 'ascii'}).trim();

request.post({
    url: sca+"/sca/task",
    json: true,
    headers: { 'Authorization': 'Bearer '+jwt },
    body: {
        instance_id: "57912b0fef01633d720918cf",
        service: "soichih/sca-service-hpss",
        config: {
            "param1": "abc",
        },
    /*
        notifications: [
            {
                "on": "complete",
                "message": "Hello there. Please visit http://happy.com",
            }
        ]
    */
    }
}, function(err, res, body) {
    if(err) throw err;
    console.dir(res.statusCode + " "+res.statusMessage);
    console.dir(body);
});


