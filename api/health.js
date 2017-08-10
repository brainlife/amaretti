
const redis = require('redis');
const winston = require('winston');

const config = require('../config');
const logger = new winston.Logger(config.logger.winston);
const db = require('./models');
const common = require('./common');
const transfer = require('./transfer'); //for health

var redis_client = redis.createClient(config.redis.port, config.redis.server);
redis_client.on('error', err=>{throw err});
redis_client.on('ready', ()=>{
    logger.info("connected to redis");
    exports.health_check();
    setInterval(exports.health_check, 1000*60); //post health status every minutes
});

exports.health_check = function() {
    //logger.debug("running api health check");
    var ssh = common.report_ssh();
    var report = {
        status: "ok",
        ssh,
        messages: [],
        date: new Date(),
    }

    //similar code exists in sca-task/sca-resource
    if(ssh.max_channels > 5) {
        report.status = "failed";
        report.messages.push("high ssh channels "+ssh.max_channels);
    }
    if(ssh.ssh_cons > 10) {
        report.status = "failed";
        report.messages.push("high ssh connections "+ssh.ssh_cons);
    }
    
    try {
        //check sshagent
        transfer.sshagent_list_keys((err, keys)=>{
            if(err) {
                report.status = 'failed';
                report.messages.push(err);
            }
            report.agent_keys = keys.length;

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

                if(report.status != "ok") logger.error(report);
                
                //report to redis
                //logger.debug("reporting to redis");
                redis_client.set("health.workflow.api."+(process.env.NODE_APP_INSTANCE||'0'), JSON.stringify(report));
            });
        });
    } catch(err) {
        logger.error("caught exception - probably from ssh_agent issue");
        logger.error(err);
    }
}

//load all heath reports posted
exports.get_reports = function(cb) { 
    redis_client.keys("health.workflow.*", (err, keys)=>{
        if(err) return cb(err);
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


