'use strict';

var fs = require('fs');
var winston = require('winston');

exports.sca = {
    auth_pubkey: fs.readFileSync(__dirname+'/auth.pub'),

    //password to encrypt/decrypt confidential resource information
    resource_enc_password: 'hogehogehoge',
    resource_cipher_algo: 'aes-256-cbc',

    //jwt token used to access other services (like auth service)
    jwt: fs.readFileSync(__dirname+'/test.jwt'),

}

//api endpoints
exports.api = {
    auth: "http://localhost/api/auth",
}

/*
exports.test = {
    //service test account/instance to use
    service: {
        user_id: "1", 
        instance_id: "570d1ef166a1e2fc1ef5a847",
    }
}
*/

exports.task_handler = {
    //max number of concurrent task execution
    concurrency: 4,
}

exports.mongodb = "mongodb://localhost/sca";

exports.express = {
    port: 12403,
}

exports.progress = {
    api: 'https://localhost/api/progress',
}

exports.workflows = {};
function register_workflow(pkg, url) { 
    exports.workflows[pkg.name] = pkg;    
    exports.workflows[pkg.name].url = url;
}
/*
register_workflow(require("/home/hayashis/git/sca-wf-qr/package.json"), "/wfui/qr");
register_workflow(require("/home/hayashis/git/sca-wf-life/package.json"), "/wfui/life");
register_workflow(require("/home/hayashis/git/sca-wf-freesurfer/package.json"), "/wfui/freesurfer");
register_workflow(require("/home/hayashis/git/sca-wf-blast/package.json"), "/wfui/blast");
register_workflow(require("/home/hayashis/git/stardock/package.json"), "/wfui/stardock");
*/

exports.resources = require('./resources');

exports.logger = {
    winston: {
        requestWhitelist: ['url', /*'headers',*/ 'method', 'httpVersion', 'originalUrl', 'query'],
        transports: [
            //display all logs to console
            new winston.transports.Console({
                timestamp: function() {
                    var d = new Date();
                    return d.toString(); 
                },
                level: 'debug',
                colorize: true
            }),
        ]
    },
}

