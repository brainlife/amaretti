
const config = require('../config');
const db = require('./models');
const common = require('./common');

const pkg = require('../package.json');

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
        //check db connectivity
        db.Instance.findOne().exec(function(err, record) {
            if(err) {
                report.status = 'failed';
                report.messages.push(err);
            } else {
                report.db_connection = "ok";
                //report.status = 'failed';
                //report.messages.push('no instance record exists');
            }

            if(report.status != "ok") console.error(report);

            common.redisClient.set("health.amaretti.api."+process.env.HOSTNAME+"-"+process.pid, JSON.stringify(report));
        });
    } catch(err) {
        console.error("caught exception - probably from ssh_agent issue");
        console.error(err);
    }
}

//load all heath reports posted
exports.get_reports = async function(cb) {
    const keys = await common.redisClient.hVals("health.amaretti.*");
    if(!keys.length) return cb(null, {});
    common.redisClient.mget(keys, (err, _reports)=>{
        if(err) return cb(err);
        var reports = {}; 
        _reports.forEach((report, idx)=>{
            reports[keys[idx]] = JSON.parse(report); 
        });
        cb(null, reports);
    });
}


