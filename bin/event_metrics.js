#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const request = require('request');
const winston = require('winston');
const async = require('async');

const config = require('../config');
const db = require('../api/models');

const duration = 1000*60; //msec to pull taskevent - should match up with the frequency of the execution

const graphite_prefix = process.argv[2];
if(!graphite_prefix) {
    console.error("usage: metrics.js <graphite_prefix>");
    process.exit(1);
}

db.init(function(err) {
    if(err) throw err;

    //grab recent events
    let recent = new Date();
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
                next();
            });
        },
    ], err=>{
        db.disconnect();
    });
});


