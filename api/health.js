
const redis = require('redis');

const config = require('../config');
const db = require('./models');
const common = require('./common');

const pkg = require('./package.json');

var redis_client = redis.createClient(config.redis.port, config.redis.server);
redis_client.on('error', err=>{throw err});
redis_client.on('ready', ()=>{
    console.info("connected to redis");
    exports.health_check();
    setInterval(exports.health_check, 1000*60); //post health status every minutes
});

exports.health_check = function() {
    var ssh = common.report_ssh();
    var report = {
        status: "ok",
        version: pkg.version,
        ssh,
        messages: [],
        date: new Date(),
    }

    if(ssh.ssh_cons > 20) {
        report.status = "failed";
        report.messages.push("high ssh connections "+ssh.ssh_cons);
    }
    
    try {
        /*
        //check sshagent
        common.sshagent_list_keys((err, keys)=>{
            if(err) {
                report.status = 'failed';
                report.messages.push(err);
            }
            report.agent_keys = keys.length;
        */

        //check db connectivity
        db.Instance.findOne().exec(function(err, record) {
            if(err) {
                report.status = 'failed';
                report.messages.push(err);
            }
            if(record) {
                report.db_connection = "ok";
            } else {
                report.status = 'failed';
                report.messages.push('no instance from db');
            }

            if(report.status != "ok") console.error(report);
            
            //report to redis
            redis_client.set("health.amaretti.api."+process.env.HOSTNAME+"-"+process.pid, JSON.stringify(report));
        });
        //});
    } catch(err) {
        console.error("caught exception - probably from ssh_agent issue");
        console.error(err);
    }
}

//load all heath reports posted
exports.get_reports = function(cb) { 
    redis_client.keys("health.amaretti.*", (err, keys)=>{
        if(err) return cb(err);
        if(!keys.length) return cb(null, {});
        redis_client.mget(keys, (err, _reports)=>{
            if(err) return cb(err);
            var reports = {}; 
            _reports.forEach((report, idx)=>{
                reports[keys[idx]] = JSON.parse(report); 
            });
            cb(null, reports);
        });
    });    
}


