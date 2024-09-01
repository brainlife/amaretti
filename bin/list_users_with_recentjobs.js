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
    list_users(err=>{
        if(err) console.error(err);
    });
});

function list_users(cb) {
    let date = new Date();
    date.setDate(date.getDate()-30);
	db.Taskevent.find({
        date: {$gt: date}
    })
    .distinct('user_id', (err, user_ids)=>{
		if(err) throw err;
        request.get({
            url: config.api.auth+"/profile/list", json: true,
            qs: {
                find: JSON.stringify({
                    sub: {$in: user_ids},
                }),
                limit: 6000, //TODO unsustainable?
            },
            headers: { authorization: "Bearer "+config.wf.jwt },
        }, function(err, res, _contacts) {
            console.log("users-----------------------------------------------");
            _contacts.profiles.forEach(contact=>{
                if(!contact.active) return;
                if(!~user_ids.indexOf(contact.sub.toString())) return;
                let name = contact.fullname.split(" ");
                console.log("\""+name[0]+"\",\""+name[1]+"\", \""+contact.email+"\"");
            });

        });
	});
}


