#!/usr/bin/env nodejs
const winston = require('winston');
const async = require('async');

const config = require('../config');
const logger = winston.createLogger(config.logger.winston);
const db = require('../api/models');
const common = require('../api/common');

common.redis.on('ready', ()=>{
    logger.info("removing amaretti.metrics.*");
    common.redis.keys("amaretti.metric.*", (err, keys)=>{
        if(err) throw err;
        console.dir(keys);
        common.redis.del(keys, (err, reps)=>{
            if(err) throw err;
            logger.debug(reps);
            process.exit(1);
        });
    });
});

