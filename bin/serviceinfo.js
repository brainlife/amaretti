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

db.init(function(err) {
    if(err) throw err;
    let service_info = {};
    async.series([

        //I might deprecate this counter in favor of more user specific counter below
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
                            },

                            user: {},
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

        //TODO - users and user seems to be redundant.. can we drop either?
        async next=>{
            console.log("group events by service/user/status");

            let finished = await db.Taskevent.aggregate([
                {$match: { status: "finished" }},
                {$group: {_id: { user: "$user_id", service: "$service"}, count: {$sum: 1}}},
            ]);
            finished.forEach(status=>{
                //if(!service_info[status._id.service]) service_info[status._id.service] = {users: {}};
                if(!service_info[status._id.service].user[status._id.user]) service_info[status._id.service].user[status._id.user] = {};
                service_info[status._id.service].user[status._id.user].finished = status.count;
            });

            let failed = await db.Taskevent.aggregate([
                {$match: { status: "failed" }},
                {$group: {_id: { user: "$user_id", service: "$service"}, count: {$sum: 1}}},
            ]);
            failed.forEach(status=>{
                if(!service_info[status._id.service].user[status._id.user]) service_info[status._id.service].user[status._id.user] = {};
                service_info[status._id.service].user[status._id.user].failed = status.count;
            });

        },

        //TODO - users and user seems to be redundant.. can we drop either?
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
            console.log("group by service and _group_id");
            db.Taskevent.aggregate([
                {$match: { status: "requested" }},
                //first aggregate by service/group
                {$group: {_id: {service: "$service", groupId: "$_group_id"}, groups: {$sum: 1}}},
                //then count to get distinct user
                {$group: {_id: {service: "$_id.service"}, distinct: {$sum: 1}}}, 
            ]).exec((err, groups)=>{
                if(err) return next(err);
                groups.forEach(group=>{
                    if(group._id.service == null) return; //TODO why does this happen?
                    service_info[group._id.service].groups = group.distinct;
                    console.log("distinct", group._id.service, group.distinct);
                });
                next();
            });
        },

        async next=>{
            /* Get all service info */
            db.Serviceinfo.find({}).exec((err,services)=>{
                if(err) return next(err);
                services.forEach(async(service)=>{
                    let countData;
                    const currentDate = new Date();
                    if(!service.monthlyCounts || !service.monthlyCounts.length) {
                        service.monthlyCounts = [];
                        //if no monthly count then add data from 2017
                        for(let year = 2017; year <= currentDate.getFullYear(); year++){
                            for(let month = 1; month <=12; month++){
                                if(year == currentDate.getFullYear() && month > currentDate.getMonth()+1) break;
                                const start = new Date(year+"-"+month+"-01");
                                const end = new Date(start);
                                end.setMonth(end.getMonth()+1);
                                countData = await db.Task.aggregate([
                                    {$match: {
                                        create_date: {$gte: start, $lt: end},
                                        service: service.service
                                    }},{
                                        $group: {
                                            _id: {service: "$service"},
                                            count: {$sum: 1},
                                            walltime: {$sum: "$runtime"}
                                        }
                                    }
                                ]);
                                if(!countData.length) service.monthlyCounts.push(undefined);
                                else service.monthlyCounts.push(countData[0].count);
                            }
                        }
                        // console.log(service.service,service.monthlyCounts.length);
                        service.save();
                    } else {
                        //if the month is already marked then updating it instead of pushing element 
                        const start = currentDate;
                        const end = new Date(start);
                        start.setMonth(end.getMonth()-1);
                        const month_difference = (end.getFullYear() - new Date('2017-01-01').getFullYear())*12 + (end.getMonth() - new Date('2017-01-01').getMonth()) - 1;
                        countData = await db.Task.aggregate([
                            {$match: {
                                create_date: {$gte: start, $lt: end},
                                service: service.service
                            }},{
                                $group: {
                                    _id: {service: "$service"},
                                    count: {$sum: 1},
                                    walltime: {$sum: "$runtime"}
                                }
                            }
                        ]);
                       
                       /* if index exists then update else push values*/
                        if(service.monthlyCounts[month_difference] == undefined || service.monthlyCounts[month_difference]) {
                            if(!countData.length) service.monthlyCounts[month_difference] = undefined;
                            else service.monthlyCounts[month_difference] = countData[0].count; 
                        } else {
                            if(!countData.length) service.monthlyCounts.push(undefined);
                            else service.monthlyCounts.push(countData[0].count); 
                        }
                        service.save();
                    }
                });
            });
        },


        /* not useful?
        next=>{
            console.log("loading README.md");
            async.eachOfSeries(service_info, (v, k, next_service)=>{
                //github doesn't support ?token= access with githubusercontent.. https://github.com/rgrove/rawgit/issues/44#issuecomment-60269961
                let url = "https://raw.githubusercontent.com/"+k+"/master/README.md";
                request(url, {
                }, (err, res)=>{
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
        */

        next=>{
            async.eachOfSeries(service_info, (v, k, next_service)=>{
                console.log("analying average runtime from the most recent 100 finishes for...", k);
                db.Taskevent.find({service: k, status: "finished"})
                .sort('-date').select('date task_id').limit(100).exec((err, finish_events)=>{
                    if(err) return next_service(err);
                    if(finish_events.length == 0) {
                        console.log("never finished..");
                        return next_service();
                    }

                    let runtimes = [];
                    //console.log("analyzing finish_event", finish_events);
                    async.eachSeries(finish_events, (finish_event, next_finish_event)=>{
                        //find when it started running for tha task
                        db.Taskevent.findOne({
                            service: k, 
                            status: {$in: ["running", "running_sync"]}, 
                            task_id: finish_event.task_id, 
                            date: {$lt: finish_event.date}
                        }).select('date').sort('-date').exec((err, start_event)=>{
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
}, false); //don't connect to amqp


