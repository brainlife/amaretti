'use strict';

var request = require('request');
var fs = require('fs');

var sca = "https://soichi7.ppa.iu.edu/api";
var jwt = fs.readFileSync('/home/hayashis/.sca/keys/cli.jwt', {encoding: 'ascii'}).trim();

console.log("submitting task 1 on karst");
request.post({
    url: sca+"/sca/task",
    json: true,
    headers: { 'Authorization': 'Bearer '+jwt },
    body: {
        instance_id: "589dcb449b8b5370ab52d5c3",
        preferred_resource_id: "579a560ec57f6be438f7d650", //karst
        service: "soichih/sca-service-noop",
        config: {
            "param1": "hello 1",
        },
        remove_date: new Date(), //should be removed immediately..
    }
}, function(err, res, body) {
    if(err) throw err;

    console.dir(res.statusCode + " "+res.statusMessage);
    console.dir(body);

    console.log("submitting task 2 on karst");
    request.post({
        url: sca+"/sca/task",
        json: true,
        headers: { 'Authorization': 'Bearer '+jwt },
        body: {
            instance_id: "589dcb449b8b5370ab52d5c3",
            preferred_resource_id: "593893d09e29ff6b38adff76", //dev1
            service: "soichih/sca-service-noop",
            config: {
                "param1": "hello 2",
            },
            deps: [ body.task._id ], //depends on task 1
            remove_date: new Date(), //should be removed immediately..
        }
    }, function(err, res, body) {
        if(err) throw err;
        console.dir(res.statusCode + " "+res.statusMessage);
        console.dir(body);
    });
});


