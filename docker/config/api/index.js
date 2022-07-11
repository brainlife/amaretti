'use strict';

const fs = require('fs');
const { createLogger, format, transports } = require('winston');
const { combine, timestamp, label } = format;

const {
    SERVICE_AUTHORITY, 
    AUTH_API_URL, 
    REDIS_URL, 
    RABBITMQ_URL, 
    MONGO_URL,
} = process.env;
const [API_HOST, API_PORT] = SERVICE_AUTHORITY.split(':');

exports.instances = process.env.instances||1;
exports.instance_id = process.env.NODE_APP_INSTANCE||0;

//used to post/poll health status from various services
//also to store various time sensitive cache data
exports.redis = {
    url: REDIS_URL,
};

exports.amaretti = {
    auth_pubkey: 'secret_dev', // @TODO generate on the fly

    //password to encrypt/decrypt confidential resource information
    resource_enc_password: 'f^g#fdkjg2.afgfBkaCS-0ddj', // @TODO generate on the fly
    resource_cipher_algo: 'aes-256-cbc',

    //jwt token used to access other services (like pulling users gids from auth service)
    jwt: '',

    //groups that all users has access to. 
    //all user will have access to any resources that are shared with this group 
    global_groups: [1],

    //show a bit more debug logging (like mongoose)
    debug: true,
}
exports.wf = exports.amaretti; //deprecated (use amaretti)
exports.sca = exports.amaretti; //deprecated (use amaretti)

//used to use github api (like service.js)
exports.github = {
    access_token: "", //https://github.com/settings/applications/487163
}

// @TODO graphite
exports.metrics = {
    resource_prefix: "dev.amaretti.resource-id",
    api: "http://10.0.0.10:2080", //graphite@monitor  @TODO point to correct service
}

exports.mailchimp = {
    api_key: '', // @TODO api to send email
}

exports.events = {
    amqp: {url: RABBITMQ_URL},
    exchange: "amaretti",
}

//api endpoints for various services
exports.api = {
    auth: AUTH_API_URL,
}

exports.test = {
    //service test account/instance to use
    service: {
        user_id: "1", 
        instance_id: "570d1ef166a1e2fc1ef5a847",
    }
}

exports.mongodb = MONGO_URL;

exports.express = {
    host: API_HOST,
    port: API_PORT,
}

exports.resources = require('./resources');

exports.logger = {
    winston: {
        level: "debug",
        format: combine(
            label({ label: 'amaretti-dev' }),
            timestamp(),
            format.colorize(),
            format.splat(),
            format.printf(info=>{
                return `${info.timestamp} [${info.label}] ${info.level}: ${info.message}`;
            }),
        ),

        requestWhitelist: ['url', /*'headers',*/ 'method', 'httpVersion', 'originalUrl', 'query'],
        exceptionHandlers: [
            new transports.Console(),
        ],

        transports: [
            new transports.Console({
                stderrLevels: ["error"],
                timestamp: function() {
                    return new Date().toString();
                },
            }),
        ]
    }
}
