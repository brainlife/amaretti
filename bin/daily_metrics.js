#!/usr/bin/env node

const config = require('../config');
const db = require('../api/models');
const influx = require('@influxdata/influxdb-client');

const mongoose = require("mongoose");
mongoose.set("debug", false); //suppress log

let graphite_prefix = process.argv[2];
if(!graphite_prefix) graphite_prefix = "dev";

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
            resolve(count);
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
            resolve(users.length);
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
            resolve(users.length);
        });
    });
}

db.init(async function(err) {
    if(err) throw err;
    let today = new Date();
    const writeApi = new influx.InfluxDB(config.influxdb.connection)
        .getWriteApi(config.influxdb.org, config.influxdb.bucket, 'ns')
    writeApi.useDefaultTags({location: config.influxdb.location})
    const point = new influx.Point("amaretti");
    point.timestamp(today);
    point.intField("tasks", await count_tasks(today));
    point.intField("user", await count_user(today));
    point.intField("active_user", await count_active_user(today));
    writeApi.writePoint(point);
    writeApi.close();

    db.disconnect();
}, false); //don't connect to amqp


