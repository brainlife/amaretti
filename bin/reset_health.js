#!/usr/bin/env node
const winston = require('winston');
const async = require('async');

const config = require('../config');
const db = require('../api/models');
const common = require('../api/common');

common.redis.on('ready', ()=>{
    console.log("removing health.amaretti.*");
    common.redis.keys("health.amaretti.*", (err, keys)=>{
        if(err) throw err;
        if(keys.length == 0) {
            console.log("no keys to remove");
            process.exit(0);
        }

        common.redis.del(keys, (err, reps)=>{
            if(err) throw err;

            //status checker needs "status" and "date".. which we can't do here
            //common.redis.set("health.amaretti.resetDate", JSON.stringify(new Date()));

            process.exit(0);
        });
    });
});

