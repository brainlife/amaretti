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

const graphite_prefix = process.argv[2]||config.sensu.prefix;
if(!graphite_prefix) {
    console.error("usage: metrics.js <graphite_prefix>");
    process.exit(1);
}

function count_tasks(d) {
    return new Promise((resolve, reject)=>{
        db.Task.estimatedDocumentCount({create_date: {$lt: d}, service: {$nin: ["soichih/sca-product-raw"]}}, (err, count)=>{
            if(err) return reject(err);
            const time = Math.round(d.getTime()/1000);
            console.log(graphite_prefix+".task.count "+count+" "+time);
            resolve();
        });
    });
}

function count_active_user(d) {
    return new Promise((resolve, reject)=>{
        db.Task.distinct('user_id', {create_date: {$lt: d}, service: {$nin: ["soichih/sca-product-raw"]}}, (err, users)=>{
            if(err) return reject(err);
            const time = Math.round(d.getTime()/1000);
            console.log(graphite_prefix+".user.active "+users.length+" "+time);
            resolve();
        });
    });
}
db.init(async function(err) {
    if(err) throw err;
    let today = new Date();
    /*
    let d = new Date("2017-01-01");
    while(d.getTime() < today.getTime()) {
        //await count_tasks(d); 
        await count_active_user(d); 
        d.setDate(d.getDate()+7);
    }
    */

    await count_tasks(today); 
    await count_active_user(today); 
    db.disconnect();
});


