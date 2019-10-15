#!/usr/bin/env node

//node
const fs = require('fs');
const path = require('path');
const os = require('os');
const request = require('request');
const winston = require('winston');
const async = require('async');
const redis = require('redis');

const config = require('../config');
config.logger.winston.transports[0].level = 'error';
const logger = winston.createLogger(config.logger.winston);
const db = require('../api/models');

const graphite_prefix = process.argv[2];
if(!graphite_prefix) {
    console.error("usage: metrics.js <graphite_prefix>");
    process.exit(1);
}

let ignored_service = [

    //old services..
    "soichih/sca-product-raw",
    "soichih/abcd-novnc",

    "brainlife/app-stage",
    "brainlife/app-archive",
    "brainlife/abcd-novnc",
];

function count_tasks(d) {
    return new Promise((resolve, reject)=>{
        db.Task.countDocuments({create_date: {$lt: d}, service: {$nin: ignored_service}}, (err, count)=>{
            if(err) return reject(err);
            const time = Math.round(d.getTime()/1000);
            console.log(graphite_prefix+".task.count "+count+" "+time);
            resolve();
        });
    });
}

function count_active_user(d) {
    return new Promise((resolve, reject)=>{
        let d30 = new Date();
        d30.setDate(d.getDate()-30);
        db.Task.distinct('user_id', {create_date: {$lt: d, $gt: d30}, service: {$nin: ignored_service}}, (err, users)=>{
            if(err) return reject(err);
            const time = Math.round(d.getTime()/1000);
            console.log(graphite_prefix+".user.active "+users.length+" "+time);
            resolve();
        });
    });
}

//number of users who's run something in the past
function count_user(d) {
    return new Promise((resolve, reject)=>{
        db.Task.distinct('user_id', {}, (err, users)=>{
            if(err) return reject(err);
            const time = Math.round(d.getTime()/1000);
            console.log(graphite_prefix+".user.total "+users.length+" "+time);
            resolve();
        });
    });
}

db.init(async function(err) {
    if(err) throw err;
    let today = new Date();
    await count_tasks(today); 
    await count_user(today); 
    await count_active_user(today); 
    db.disconnect();
});


