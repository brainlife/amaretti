#!/usr/bin/env node

//node
const fs = require('fs');
const path = require('path');
const os = require('os');
const request = require('request');
const winston = require('winston');
const async = require('async');

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
    let users = [];

    list.forEach(item=>{
        let service = item._id.service;
        let resource_id = item._id.resource_id;
        let user_id = item._id.user_id;
        let count = item.count;

        if(!services[service]) services[service] = 0;
        services[service] += count;

        if(!users[user_id]) users[user_id] = 0;
        users[user_id] += count;

        if(resource_id) {
            if(!resources[resource_id]) resources[resource_id] = 0;
            resources[resource_id] += count;
        }
    });

    //let's pull contact details
    async.parallel({

        resource_details: cb=>{
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
                let resource_details = {};
                _resources.resources.forEach(resource=>{
                    resource_details[resource._id] = resource;
                });
                cb(err, resource_details);
            });
        },

        contact_details: cb=>{
            request.get({
                url: config.api.auth+"/profile", json: true,
                qs: {
                    find: JSON.stringify({
                        _id: {$in: Object.keys(users)},
                    }),
                },
                headers: { authorization: "Bearer "+config.wf.jwt },
            }, function(err, res, _contacts) {
                let contact_details = {};
                _contacts.profiles.forEach(contact=>{
                    contact_details[contact.id] = contact;
                });
                cb(err, contact_details);
            });
        },

    }, (err, results)=>{
        //console.dir(results.contact_details);
        //now emit
        let time = Math.round(new Date().getTime()/1000);
        for(let service in services) {
            let safe_name = sensu_name(service).replace("/", ".");
            console.log(config.sensu.prefix+".service."+safe_name+" "+services[service]+" "+time);
        }
        for(let resource_id in resources) {
            let detail = results.resource_details[resource_id];
            console.log(config.sensu.prefix+".resource."+sensu_name(detail.name)+" "+resources[resource_id]+" "+time);
        }
        for(let user_id in users) {
            let user = results.contact_details[user_id];
            console.log(config.sensu.prefix+".users."+user.username+" "+users[user_id]+" "+time);
        }
    });
});


