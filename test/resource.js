'use strict';

//contrib
var request = require('supertest')
var assert = require('assert');
var fs = require('fs');

//mine
var config = require('./config');
var db = require('../api/models/db');
var app = require('../api/server').app;

describe('/resource', function() {
    var resource = null;

    it('create new resource', function(done) {
        request(app)
        .post('/resource')
        .set('Authorization', 'Bearer '+config.sca.jwt)
        .set('Accept', 'application/json')
        .send({
            resource_id: "test",
            type: "hpss",
            name: "test resource",
            active: true,
            gids: [0,1,2],
            envs: {
                "test": 123,
            },
            config: {
                "auth_method": "keytab",
                "username": "hayashis",
                "enc_keytab": "set later..",
            },
        })
        .expect('Content-Type', /json/) 
        .expect(200)
        .end(function(err, res) {
            if(err) return done(err);
            resource = res.body;
            console.dir(resource);
            assert(resource.name == "test resource");
            assert.deepEqual(resource.gids, [0,1,2]);
            done()
        });
    });

    xit('setkeytab', function(done) {
        request(app)
        .post('/resource/setkeytab/'+resource._id)
        .set('Authorization', 'Bearer '+config.sca.jwt)
        .set('Accept', 'application/json')
        .send({
            username: process.env.TEST_USERNAME,
            password: process.env.TEST_PASSWORD,
        })
        //TODO - I should validate if end_keytab is set properly.. but how?
        .expect(200, {message: 'ok'}, done);
    });

    xit('installsshkey', function(done) {
        request(app)
        .post('/resource/installsshkey')
        .set('Accept', 'application/json')
        .send({
            hostname: "karst.uits.iu.edu",
            username: process.env.TEST_USERNAME,
            password: process.env.TEST_PASSWORD,
        })
        .expect(200, {message: 'ok'}, done);
    });

    it('delete the test resource', function(done) {
        request(app)
        .delete('/resource/'+resource._id)
        .set('Authorization', 'Bearer '+config.sca.jwt)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/) 
        .expect(200, done);
    });
});

