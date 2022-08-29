#!/usr/bin/env node
const async = require('async');

const config = require('../config');
const db = require('../api/models');
const redis = require('redis');

const rcon = redis.createClient(config.redis.port, config.redis.server);
rcon.on('error', err=>{throw err});
rcon.on('ready', ()=>{
    console.log("removing health.amaretti.*");
    rcon.keys("health.amaretti.*", (err, keys)=>{
        if(err) throw err;
        if(keys.length == 0) {
            console.log("no keys to remove");
            process.exit(0);
        }

        rcon.del(keys, (err, reps)=>{
            if(err) throw err;
            process.exit(0);
        });
    });
});

