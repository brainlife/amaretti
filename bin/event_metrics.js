#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const request = require('request');
const async = require('async');

const config = require('../config');
const db = require('../api/models');
const influx = require('@influxdata/influxdb-client');

const duration = 1000*60; //msec to pull taskevent - should match up with the frequency of the execution

let graphite_prefix = process.argv[2];
if(!graphite_prefix) graphite_prefix = "dev";

db.init(function(err) {
    if(err) throw err;

    //grab recent events
    let recent = new Date();

    const writeApi = new influx.InfluxDB(config.influxdb.connection)
        .getWriteApi(config.influxdb.org, config.influxdb.bucket, 'ns')
    writeApi.useDefaultTags({location: config.influxdb.location})
    const point = new influx.Point("amaretti");
    point.timestamp(recent);

    recent.setTime(recent.getTime()-duration);
    async.series([
        next=>{
            db.Taskevent.find({date: {$gt: recent}}).exec((err, events)=>{
                if(err) throw err;

                let counts = {
                    failed: 0,
                    finished: 0,
                    removed: 0,
                    requested: 0,
                    running: 0,
                    running_sync: 0,
                    stop_requested: 0,
                    stopped: 0,
                    waiting: 0,
                };
                events.forEach(event=>{
                    counts[event.status]++;
                });

                const time = Math.round(new Date().getTime()/1000);
                for(let status in counts) {
                    console.log(graphite_prefix+".events.status."+status+" "+counts[status]+" "+time);
                    point.intField("event_status."+status, counts[status]);
                }
                next();
            });
        },

        //not really event related, but right now there is no better place to check the queue count
        next=>{
            //WARNING.. same code in bin/task.js
            db.Task.countDocuments({
                status: {$ne: "removed"}, //ignore removed tasks
                $or: [
                    {next_date: {$exists: false}},
                    {next_date: {$lt: new Date()}}
                ]
            }).exec((err, count)=>{
                if(err) return next(err);
                const time = Math.round((new Date()).getTime()/1000);
                console.log(graphite_prefix+".task.queuesize "+count+" "+time);
                point.intField("task_queuesize", count);
                next();
            });
        },
    ], err=>{
        writeApi.writePoint(point);
        writeApi.close();

        db.disconnect();
        console.log("all done");
    });
}, false); //don't connect to event 


