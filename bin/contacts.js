#!/usr/bin/env node

const winston = require('winston');
const async = require('async');
const request = require('request');
const fs = require('fs');
const redis = require('redis');
const jsonwebtoken = require('jsonwebtoken');

const config = require('../config');
const logger = new winston.Logger(config.logger.winston);
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
            url: config.api.auth+"/profile", json: true,
            qs: {
                find: JSON.stringify({
                    _id: {$in: Object.keys(user_ids)},
                }),
                limit: 5000, //TODO unsustainable?
            },
            headers: { authorization: "Bearer "+config.wf.jwt },
        }, function(err, res, _contacts) {
            let contact_details = {};
            _contacts.profiles.forEach(contact=>{
                contact_details[contact.id] = contact;
            });

            console.log("users-----------------------------------------------");
            console.log("\"fullname\",\"email\"");
            _contacts.profiles.forEach(contact=>{
                console.log("\""+contact.fullname+"\",\""+contact.email+"\"");
            });
        });
     /*
        //console.log("\"id\",\"uid\",\"fullname\",\"email\",\"app\"");
        let contacts = {} ;
        async.eachSeries(apps, (app, next_app)=>{
            app.admins.forEach(id=>{
                let contact = common.deref_contact(id);
                if(contact) {
                    //console.log("\""+id+"\",\""+contact.username+"\",\""+contact.fullname+"\",\""+contact.email+"\",\""+app.github+"\"");
                    contacts[id] = contact;
                } else {
                    console.log("missing", id);
                }
            });
            next_app();
        }, err=>{
            if(err) return cb(err);

            console.log("app-----------------------------------------------");
            console.log("\"fullname\",\"email\"");
            for(let id in contacts) {
                console.log("\""+contacts[id].fullname+"\",\""+contacts[id].email+"\"");
            }
            logger.debug("done with all apps");
            cb();
        });
        */
	});
}


