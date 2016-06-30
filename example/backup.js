'use strict';

var request = require('request');
var fs = require('fs');

var sca = "https://soichi7.ppa.iu.edu/api";
var jwt = fs.readFileSync('/home/hayashis/.sca/keys/cli.jwt', {encoding: 'ascii'}).trim();

var instance_id = "5716ae31d43e9a2e1649e927";

function get_resources(cb) {
    request.get({
        url: sca+"/sca/resource",
        json: true,
        headers: { 'Authorization': 'Bearer '+jwt },
        qs: {
            find: JSON.stringify({resource_id: {$in: ['sda', 'karst']}})
        }
    }, function(err, res, resources) {
        if(err) return cb(err);
        if(res.statusCode != "200") return cb("request failed with code:"+res.statusCode);

        var sda_resource = null;
        var karst_resource = null;

        //go through resources and find any sda / karst resources
        console.dir(resources);
        resources.forEach(function(resource) {
            if(resource.resource_id == "sda") sda_resource = resource;
            if(resource.resource_id == "karst") karst_resource = resource;
        });
        cb(null, sda_resource, karst_resource);
    });
}

function submit_tar(karst_resource, cb) {
    request.post({
        url: sca+"/sca/task",
        json: true,
        headers: { 'Authorization': 'Bearer '+jwt },
        body: {
            instance_id: instance_id,
            service: "soichih/sca-product-raw",
            preferred_resource_id: karst_resource._id, //not really needed but in case there are more than 1..
            config: {
                tar: [
                    {src: "/N/dc2/scratch/odiuser/SPIE_MasterCals_headers", dest: "backup.tar.gz", opts: "gz"}
                ]
            },
        }
    }, function(err, res, body) {
        if(err) throw err;
        console.log(body.message); //should be "Task successfully submitted"
        cb(null, body.task);
    });
}

function submit_hpss(karst_resource, sda_resource, tar_task, cb) {
    request.post({
        url: sca+"/sca/task",
        json: true,
        headers: { 'Authorization': 'Bearer '+jwt },
        body: {
            instance_id: instance_id,
            service: "soichih/sca-service-hpss",
            preferred_resource_id: karst_resource._id, //not really needed but in case there are more than 1..
            deps: [tar_task._id],
            resource_deps: [sda_resource._id],
            config: {
                put: [
                    //use tar_task ID as hpss filename
                    {localpath:"../"+tar_task._id+"/backup.tar.gz", hpsspath:"backup/"+tar_task._id+".tar.gz"}
                ],
                auth: {
                    username: sda_resource.config.username,
                    keytab: sda_resource._id+".keytab",
                },
                //add a bit of extra info.. to help querying via backiup cli
                info: {
                    /*
                    hostname: os.hostname(),
                    //platform: os.platform(), //bit redundant with os.type()
                    release: os.release(),
                    type: os.type(),
                    path: process.cwd()+"/"+dir,
                    files: fs.readdirSync(dir),
                    */
                }
            },
        }
    }, function(err, res, body) {
        if(err) throw err;
        console.log(JSON.stringify(body.message, null, 4)); //should be "Task successfully submitted"
        cb(null, body.task);
    });
}

get_resources(function(err, sda_resource, karst_resource) {
    if(err) throw err;
    //console.dir(sda_resource);
    //console.dir(karst_resource);
    if(!karst_resource) throw new Error("couldn't find karst resource");
    if(!sda_resource) throw new Error("couldn't find sda resource");

    submit_tar(karst_resource, function(err, tar_task) {
        if(err) throw err;
        submit_hpss(karst_resource, sda_resource, tar_task, function(err, hpss_task) {
            if(err) throw err;
            console.log(JSON.stringify(hpss_task, null, 4)); //should be "Task successfully submitted"
        });
    });
});



