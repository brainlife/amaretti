#!/usr/bin/env nodejs
const async = require('async');

const config = require('../config');
const db = require('../api/models');
const common = require('../api/common');

common.connectRedis(async ()=>{
    console.info("removing amaretti.metrics.*");
    const keys = await common.redisClient.hVals("amaretti.metric.*");
    console.dir(keys);
    for(const key of keys) {
        await common.redisClient.del(keys);
    }
    common.redisClient.quit();
});

