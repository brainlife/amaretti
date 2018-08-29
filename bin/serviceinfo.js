#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const request = require('request');
const winston = require('winston');
const async = require('async');

const config = require('../config');
const db = require('../api/models');

db.init(function(err) {
    if(err) throw err;

    /*
    //grab recent events
    let recent = new Date();
    recent.setTime(recent.getTime()-duration);
    db.Taskevent.find({date: {$gt: recent}}).exec((err, events)=>{
        if(err) throw err;

        let counts = {
            failed: 0,
            finished: 0,
            removed: 0,
            requested: 0,
            running: 0,
            running_sync: 0,
            stop_requested: 0,
            stopped: 0,
            waiting: 0,
        };
        events.forEach(event=>{
            counts[event.status]++;
        });

        const time = Math.round(new Date().getTime()/1000);
        for(let status in counts) {
            console.log(graphite_prefix+".events.status."+status+" "+counts[status]+" "+time);
        }

        db.disconnect();
    });
    */

    let service_info = {};
    async.series([
        next=>{
            console.log("group events by service and status");
            db.Taskevent.aggregate([
                //{$match: find},
                {$group: {_id: { status: "$status", service: "$service"}, count: {$sum: 1}}},
            ]).exec((err, statuses)=>{
                if(err) return next(err);
                console.log("got service state counts");
                /*
                //count distinct users requested (TODO is there a better way?)
                db.Taskevent.find(find).distinct('user_id').exec(function(err, users) {
                    if(err) return next(err);
                    console.dir({
                        counts: counts,
                        users: users.length,
                    });
                });
                */
                //console.log(JSON.stringify(statuses, null, 4));
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
                            users: null,
                        }
                    }
                    service_info[status._id.service].counts[status._id.status] = status.count;
                });
                next();
            });
        },

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
                console.log("got user count"); 
                //console.log(JSON.stringify(users, null, 4));
                users.forEach(user=>{
                    service_info[user._id.service].users = user.distinct;
                });
                next();
            });
        },

        next=>{
            console.log("computing average runtime");

            /*
            //first pick the most recent finish events for each services
            db.Taskevent.aggregate([
                {$match: { status: "finished", service: {$nin: [
                    "soichih/sca-service-noop",
                    "soichih/sca-product-raw",
                ] } }},
                
                //first aggregate by service/user
                {$group: {_id: {service: "$service", task_id: "$task_id", date: "$date"}}}, 
            ]).exec((err, finishes)=>{
                if(err) return next(err);
                //console.dir(finishes);
                finishes.forEach(finish=>{
                    console.log(finish._id.service);
                    console.dir(finish._id.task_id.toString());
                });
            });
            */
            async.eachOfSeries(service_info, (v, k, next_service)=>{
                console.log("find the most recent finish for...", k);
                db.Taskevent.findOne({service: k, status: "finished"}).sort('-date').exec((err, finish_event)=>{
                    if(err) return next_service(err);
                    //console.dir(finish_event.toObject());
                    if(!finish_event) {
                        console.log("never finished..");
                        return next_service();
                    }
                    
                    //find when it started running for tha task
                    //console.log("finding running event", finish_event.task_id);
                    db.Taskevent.findOne({service: k, status: "running", task_id: finish_event.task_id, date: {$lt: finish_event.date}}).sort('-date').exec((err, start_event)=>{
                        if(err) return next_service(err);
                        if(!start_event) {
                            console.log("no running event.. maybe sync service?");
                            return next_service();
                        }
                        //console.log("looking started..");
                        //console.dir(start_event.toObject());
                        //console.log("todo.............");
                        //console.dir(start_event.toObject());
                        //console.dir(finish_event.toObject());
                        service_info[k].runtime = finish_event.date - start_event.date;
                        console.log(service_info[k].runtime);
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
                    s.counts = info.counts;
                    s.users = info.users;
                    s.runtime = info.runtime; //TODO - should I average?
                    s.save(next_service);
                }
            });
        }, err=>{
            if(err) throw err;
            console.log("all done");
            db.disconnect();
        });
    });
});


