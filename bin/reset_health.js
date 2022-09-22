#!/usr/bin/env node
const async = require('async');

const config = require('../config');
const db = require('../api/models');
const common = require('../api/common');
const redis = require('redis');

common.connectRedis(async ()=>{
    console.log("removing health.amaretti.*");
    const keys = await common.redisClient.hVals("health.amaretti.*");
    if(keys.length == 0) {
        console.log("no keys to remove");
    } else {
        await rcon.del(keys);
    }
    common.redisClient.quit();
});

