#!/usr/bin/env node

const async = require('async');
const request = require('request');
const fs = require('fs');
const redis = require('redis');
const jsonwebtoken = require('jsonwebtoken');

const config = require('../config');
const db = require('../api/models');
const common = require('../api/common');

db.init(err=> {
    if(err) throw err;
    request.get({
        url: config.api.auth+"/profile/list", json: true,
        qs: {
            find: JSON.stringify({
                active: true,
            }),
            limit: 5000, //TODO unsustainable?
        },
        headers: { authorization: "Bearer "+config.wf.jwt },
    }, function(err, res, data) {
        if(err) throw err;
        let recs = [];

        async.eachSeries(data.profiles, (contact, next_contact)=>{

            //count number of jobs this person has submitted
            db.Task.countDocuments({user_id: contact.sub}).exec((err, counts)=>{
                if(err) return next_contact(err);
                rec = "\""+contact.fullname+"\",\""+contact.email+"\",\""+counts+"\"";
                console.log(rec);
                recs.push(rec);
                next_contact();
            });
        }, err=>{
            if(err) throw err;
            console.log("saving /tmp/contacts.csv"); 
            fs.writeFileSync("/tmp/contacts.csv", recs.join("\n"));
            console.log("done");
        });
	});
});


