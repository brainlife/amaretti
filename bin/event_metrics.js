#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const request = require('request');
const winston = require('winston');
const async = require('async');
const redis = require('redis');

const config = require('../config');
//const logger = new winston.Logger(config.logger.winston);
const db = require('../api/models');

//connect to redis - used to store previously non-0 data
//const re = redis.createClient(config.redis.port, config.redis.server);

const graphite_prefix = process.argv[2];
if(!graphite_prefix) {
    console.error("usage: metrics.js <graphite_prefix>");
    process.exit(1);
}

db.init(function(err) {
    if(err) throw err;

    //grab recent events
    let recent = new Date();
    recent.setTime(recent.getTime()-1000*60); //60 seconds?
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
            //if(counts[event.status] === undefined) counts[event.status] = 1;
            counts[event.status]++;
        });

        const time = Math.round(new Date().getTime()/1000);
        for(let status in counts) {
            console.log(graphite_prefix+".events.status."+status+" "+counts[status]+" "+time);
        }

        db.disconnect();
    });
});


