#!/usr/bin/env node

//node
const fs = require('fs');
const path = require('path');
const os = require('os');
const request = require('request');
const winston = require('winston');

//mine
const config = require('../config');
const logger = new winston.Logger(config.logger.winston);
//const db = require('../api/models');

function sensu_name(name) {
    name = name.toLowerCase();
    name = name.replace(/[_.@$#\/]/g, "-");
    name = name.replace(/ /g, "");
    return name;
}

//I can just load this directly from mongo.. but to be consistent 
//with what user sees (via API) let's pull it from API..
request.get({
    url: "http://localhost:"+config.express.port+"/admin/services/running", json: true,
    headers: { authorization: "Bearer "+config.wf.jwt },
}, function(err, res, list) {
    if(err) throw err;
    //convert list of service/resouce_id keys into various statistics
    let services = [];
    let resources = [];

    list.forEach(item=>{
        let service = item._id.service;
        let resource_id = item._id.resource_id;
        let count = item.count;


        /*
        //make service sensu safe name
        let service_org = sensu_safe(service.split("/")[0]);
        let service_name = sensu_Safe(service.split("/")[1]);
        console.log(service_org);
        console.log(service_name);
        */

        if(!services[service]) services[service] = 0;
        services[service] += count;

        if(resource_id) {
            if(!resources[resource_id]) resources[resource_id] = 0;
            resources[resource_id] += count;
        }

    });

    //let's pull resource detail
    request.get({
        url: "http://localhost:"+config.express.port+"/resource", json: true,
        qs: {
            find: JSON.stringify({
                _id: {$in: Object.keys(resources)},
                user_id: null, //admin can do this to bypass user id filtering
            }),
        },
        headers: { authorization: "Bearer "+config.wf.jwt },
    }, function(err, res, _resources) {
        if(err) throw err;

        let resource_details = {};
        _resources.resources.forEach(resource=>{
            resource_details[resource._id] = resource;
        });
            
        //now emit
        let time = Math.round(new Date().getTime()/1000);
        for(let service in services) {
            let safe_name = sensu_name(service).replace("/", ".");
            console.log(config.sensu.prefix+".service."+safe_name+" "+services[service]+" "+time);
        }
        for(let resource_id in resources) {
            let detail = resource_details[resource_id];
            console.log(config.sensu.prefix+".resource."+sensu_name(detail.name)+" "+resources[resource_id]+" "+time);
        }
    });
});


