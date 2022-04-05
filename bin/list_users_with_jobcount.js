#!/usr/bin/env node

const async = require('async');
const request = require('request');
const axios = require('axios');
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
                'profile.private.notification.newsletter_general': true,
            }),
            limit: 5000, //TODO unsustainable?
        },
        headers: { authorization: "Bearer "+config.wf.jwt },
    }, function(err, res, data) {
        if(err) throw err;
        //let recs = [];
        async.eachSeries(data.profiles, (contact, next_contact)=>{
            //console.dir(contact.profile);

            //count number of jobs this person has submitted
            db.Task.countDocuments({user_id: contact.sub}).exec((err, counts)=>{
                if(err) return next_contact(err);
                if(counts == 0) {
                    console.log("skipping user with 0 task count - keep under quota");
                    console.dir(contact);
                    return next_contact();
                }

                /*
                let name = contact.fullname.split(" ");
                let tags = [];
                let rec = {
                    status: "subscribed",
                    tags,
                    vip: (counts>100?true:false),
                    email_address: contact.email,
                    merge_fields: {
                        FNAME: name.shift(),
                        LNAME: name.join(" "),
                    } 
                }
                console.log(rec);

				//https://mailchimp.com/developer/reference/lists/list-members/#post_/lists/-list_id-/members
				axios.post("https://us12.api.mailchimp.com/3.0/lists/8d07cef694/members", rec, {auth: {
                    username: "anystring",
                    password: config.mailchimp.api_key,
                }}).then(res=>{
					console.dir(res.data);
					next_contact();
				}).catch(err=>{
					console.dir(err.response.data);
					next_contact();
				});
                */
                console.log(contact, counts);
                next_contact();

            });
        }, err=>{
            if(err) throw err;
            console.log("done");
        });
	});
});

