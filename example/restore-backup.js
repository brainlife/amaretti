'use strict';

var request = require('request');
var fs = require('fs');
var os = require('os');
var path = require('path');

var sca = "https://soichi7.ppa.iu.edu/api";
var jwt = fs.readFileSync('/home/hayashis/.sca/keys/cli.jwt', {encoding: 'ascii'}).trim();

var instance_id = "5716ae31d43e9a2e1649e927";

function submit_restore(backup_task, cb) {
    var hpss_path = backup_task.products[0].files[0].path;
    request.post({
        url: sca+"/sca/task",
        json: true,
        headers: { 'Authorization': 'Bearer '+jwt },
        body: {
            instance_id: instance_id,
            name: "restore",
            service: "soichih/sca-service-hpss",
            preferred_resource_id: backup_task.resource_id, //use the same karst resource we used to backup
            resource_deps: backup_task.resource_deps, //use the same SDA resource we used
            config: {
                auth: backup_task.config.auth,
                get: [
                    {localdir:".", hpsspath:hpss_path}
                ],
            },
        }
    }, function(err, res, body) {
        if(err) return cb(err);
        console.log(JSON.stringify(body.message, null, 4)); //should be "Task successfully submitted"
        cb(null, body.task);
    });
}

function submit_untar(karst_resource_id, fname, hpss_task, cb) {
    request.post({
        url: sca+"/sca/task",
        json: true,
        headers: { 'Authorization': 'Bearer '+jwt },
        body: {
            instance_id: instance_id,
            service: "soichih/sca-product-raw",
            preferred_resource_id: karst_resource_id, //use the same karst resource we used to backup
            deps: [ hpss_task._id ],
            config: {
                untar: [ 
                    {src: "../"+hpss_task._id+"/"+fname, dest: "/N/u/hayashis/Karst/tmp", opts: "gz"}
                ]
            },
        }
    }, function(err, res, body) {
        if(err) return cb(err);
        console.log(JSON.stringify(body.message, null, 4)); //should be "Task successfully submitted"
        cb(null, body.task);
    });
}

//find random backup task to restore
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
    if(err) throw err;
    if(res.statusCode != "200") return cb("request failed with code:"+res.statusCode);

    var task = tasks[0];
    console.log("restoring "+task._id);
    submit_restore(task, function(err, hpsstask) {
        if(err) throw err;
        console.dir(hpsstask);
        var hpss_path = task.products[0].files[0].path;
        var fname = path.basename(hpss_path);
        submit_untar(task.resource_id, fname, hpsstask, function(err, untar) {
            if(err) throw err;
            console.dir(untar);
        });
    });
});

