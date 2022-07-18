#!/usr/bin/env nodejs
const async = require('async');

const config = require('../config');
const db = require('../api/models');
const common = require('../api/common');

common.redis.on('ready', ()=>{
    console.info("removing amaretti.metrics.*");
    common.redis.keys("amaretti.metric.*", (err, keys)=>{
        if(err) throw err;
        console.dir(keys);
        common.redis.del(keys, (err, reps)=>{
            if(err) throw err;
            console.debug(reps);
            process.exit(1);
        });
    });
});

