#!/usr/bin/env node

//populate serviceinfos collection by parsing Taskevent collection

const fs = require('fs');
const path = require('path');
const os = require('os');
const winston = require('winston');
const request = require('request');
const async = require('async');
const ss = require('simple-statistics');

const config = require('../config');
const db = require('../api/models');
//const service = require('../api/service');

db.init(function(err) {
    if(err) throw err;
    let service_info = {};
    async.series([

        next=>{
            console.log("group events by service and status");
            db.Taskevent.aggregate([
                {$group: {_id: { status: "$status", service: "$service"}, count: {$sum: 1}}},
            ]).exec((err, statuses)=>{
                if(err) return next(err);
                console.log("got service state counts");
                statuses.forEach(status=>{
                    if(!service_info[status._id.service]) {
                        //init
                        service_info[status._id.service] = {
                            counts: {
                                failed: 0,
                                finished: 0,
                                removed: 0,
                                requested: 0,
                                running: 0,
                                running_sync: 0,
                                stop_requested: 0,
                                stopped: 0,
                            }
                        }
                    }
                    service_info[status._id.service].counts[status._id.status] = status.count;
                    
                    //calculate success_rate
                    let finished = service_info[status._id.service].counts.finished;
                    let failed = service_info[status._id.service].counts.failed;
                    if(finished+failed > 0) service_info[status._id.service].success_rate = (finished / (failed+finished))*100;
                });
                next();
            });
        },

        /*
        //TODO - will be deprecated soon - now that we are moving to graphite to store this
        next=>{
            console.log("also generate last 180 days usage graph");
            let hist_days = 180;
            let hist_start = new Date(Date.now() - 3600*24*hist_days*1000);
            db.Taskevent.aggregate([
                {$match: {
                    service: { $nin: ["soichih/sca-service-noop", "brainlife/app-noop"] },
                    date: {$gt: hist_start},
                }}, 
                {$project: { date: {$substr: ["$date", 0, 10]}, status: "$status", service: "$service"}},
                {$group: {_id: { status: "$status", service: "$service", date: "$date" }, count: {$sum: 1}}},
            ]).exec((err, events)=>{
                if(err) return next(err);

                let empty = [];
                for(let d = -hist_days; d != 0;d++) empty.push(0);

                for(let service in service_info) {
                    //service_info[service].hist_start = hist_start;
                    //service_info[service].hist_days = hist_days;
                    service_info[service].hist = {
                        failed: empty.slice(),
                        finished: empty.slice(),
                        removed: empty.slice(),
                        requested: empty.slice(),
                        running: empty.slice(),
                        running_sync: empty.slice(),
                        //stop_requested: empty.slice(),
                        //stopped: empty.slice(),
                    }
                }

                //populate from events
                events.forEach(event=>{
                    if(!event._id.date) {
                        return;
                    }
                    let etime = new Date(event._id.date);
                    let d = Math.floor((etime.getTime() - hist_start.getTime())/(3600*24*1000));
                    if(service_info[event._id.service].hist[event._id.status]) {
                        service_info[event._id.service].hist[event._id.status][d] = event.count;
                    }
                    //console.dir(service_info[event._id.service]);
                });
                next();
            });
        },
        */

        next=>{
            console.log("group by service and user count");
            db.Taskevent.aggregate([
                {$match: { status: "requested" }},
                //first aggregate by service/user
                {$group: {_id: {service: "$service", user: "$user_id"}, users: {$sum: 1}}}, 
                //then count users to get distinct user
                {$group: {_id: {service: "$_id.service"}, distinct: {$sum: 1}}}, 
            ]).exec((err, users)=>{
                if(err) return next(err);
                //console.log("got user count"); 
                //console.log(JSON.stringify(users, null, 4));
                users.forEach(user=>{
                    if(user._id.service == null) return; //TODO why does this happen?
                    service_info[user._id.service].users = user.distinct;
                });
                next();
            });
        },

        next=>{
            console.log("loading README.md");
            async.eachOfSeries(service_info, (v, k, next_service)=>{
                let url = "https://raw.githubusercontent.com/"+k+"/master/README.md";
                request(url, (err, res)=>{
                    let status = "ok";
                    if(err) status = err.toString();
                    else if(res.statusCode != 200) status = "no README.md";
                    else if(!res.body) status = "empty";
                    else if(res.body.length < 1000) status = "too short";
                    service_info[k].readme_status = status;
                    //console.log(k, status);
                    next_service();
                });
            }, next);
        },

        next=>{
            console.log("computing average runtime");
            async.eachOfSeries(service_info, (v, k, next_service)=>{
                console.log("find the most recent N finishes for...", k);
                db.Taskevent.find({service: k, status: "finished"}).sort('-date').limit(10).exec((err, finish_events)=>{
                    if(err) return next_service(err);
                    if(finish_events.length == 0) {
                        console.log("never finished..");
                        return next_service();
                    }

                    let runtimes = [];
                    console.log("analyzing finish_event", finish_events);
                    async.eachSeries(finish_events, (finish_event, next_finish_event)=>{
                        //find when it started running for tha task
                        db.Taskevent.findOne({service: k, status: {$in: ["running", "running_sync"]}, task_id: finish_event.task_id, date: {$lt: finish_event.date}}).sort('-date').exec((err, start_event)=>{
                            if(err) return next_finish_event(err);
                            if(!start_event) {
                                console.log("no running/running_sync event.. odd?");
                                return next_finish_event();
                            }
                            runtimes.push(finish_event.date - start_event.date);
                            next_finish_event();
                        });
                    }, err=>{
                        if(err) return next_service(err);
                        /*
                        if(runtimes.length == 0) {
                            console.log("no runtime info");
                            return next_service();
                        }
                        */
                        service_info[k].runtime_mean = ss.mean(runtimes);
                        service_info[k].runtime_std = ss.standardDeviation(runtimes);
                        //console.dir(service_info[k]);
                        next_service();
                    });
                });
            }, next);
        },


    ], err=>{
        if(err) throw err;
        console.log("saving");
        async.eachOfSeries(service_info, (v, k, next_service)=>{
            let info = service_info[k]; 
            db.Serviceinfo.findOne({service: k}).exec((err, s)=>{
                if(err) throw err;
                if(!s) {
                    console.log("need to insert", k);
                    s = new db.Serviceinfo(info);
                    s.service = k;
                    s.save(next_service);
                } else {
                    console.log("updating", k);
                    for(var key in info) s[key] = info[key];
                    //s.counts = info.counts;
                    //s.users = info.users;
                    //s.runtime = info.runtime; //TODO - should I average?
                    s.save(next_service);
                }
            });
        }, err=>{
            if(err) throw err;
            console.log("all done");
            db.disconnect();
            /*
            setTimeout(()=>{
                console.log("somehow doesn't terminate... so killing myself");
                process.exit(1);
            }, 2000);
            */
        });
    });
});


