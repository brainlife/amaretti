'use strict';

const fs = require('fs');
//const { createLogger, format, transports } = require('winston');
//const { combine, timestamp, label, prettyPrint } = format;

exports.instances = process.env.instances||1;
exports.instance_id = process.env.NODE_APP_INSTANCE||0;

//used to post/poll health status from various services
//also to store various time sensitive cache data
exports.redis = { url: "redis://brainlife_redis_1" };

exports.amaretti = {
    auth_pubkey: fs.readFileSync(__dirname+'/auth.pub', 'ascii').trim(),

    //password to encrypt/decrypt confidential resource information
    resource_enc_password: 'todayWillBeA$eautifullDay',
    resource_cipher_algo: 'aes-256-cbc',

    //jwt token used to access other services (like pulling users gids from auth service)
    jwt: fs.readFileSync(__dirname+'/amaretti.jwt', 'ascii').trim(),

    //groups that all users has access to. 
    //all user will have access to any resources that are shared with this group 
    globalGroup: 1,

    //show a bit more debug logging (like mongoose)
    debug: false,
}
exports.wf = exports.amaretti; //deprecated (use amaretti)
exports.sca = exports.amaretti; //deprecated (use amaretti)

//used to use github api (like service.js)
//obtain it from https://github.com/settings/tokens (
//exports.github = { access_token: fs.readFileSync(__dirname+'/github.access_token', 'ascii').trim()};

exports.metrics = {
    resource_prefix: "dev.amaretti.resource-id",
    api: "http://10.0.0.10:2080", //graphite@monitor 
}

exports.influxdb = {
    connection: {
        url: "http://brainlife_influxdb_1:8086",
        token: "mydevtoken",
    },
    org: "brainlife",
    bucket: "brainlife",
    location: "localhost",

    //countInterval: 10*1000,~
    //healthInterval: 10*1000,~
}

exports.mailchimp = {
    api_key: "getitfrommailchimp",
}

exports.events = {
    amqp: {
        url: "amqp://guest:guest@brainlife_rabbitmq_1:5672/brainlife"
    },

    exchange: "wf", //used as prefix for full exchange name.. (should be renamed to amaretti?)
}

exports.api = {
    auth: "http://brainlife_auth-api_1:8080",
}

exports.test = {
    //service test account/instance to use
    //TODO is this still used?
    service: {
        user_id: "1", 
        instance_id: "570d1ef166a1e2fc1ef5a847",
    }
}

exports.mongodb = "mongodb://brainlife_mongodb_1/amaretti";

exports.express = {
    host: "0.0.0.0",
    port: 8080,
}

exports.resources = {}

