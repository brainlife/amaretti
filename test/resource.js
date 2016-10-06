'use strict';

//contrib
var request = require('supertest')
var assert = require('assert');
var fs = require('fs');

//mine
var config = require('../config');
var db = require('../api/models/db');
var app = require('../api/server').app;

//config.sca.jwt is admin token.. if I want to test as normal user, I need to use userjwt
var userjwt = fs.readFileSync(__dirname+'/config/user.jwt');

describe('/resource', function() {
    var resource = null;
    var resource2 = null;

    it('create new resource', function(done) {
        request(app)
        .post('/resource')
        .set('Authorization', 'Bearer '+config.sca.jwt)
        .set('Accept', 'application/json')
        .send({
            resource_id: "sda",
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
            //console.dir(resource);
            assert(resource.name == "test resource");
            assert.deepEqual(resource.gids, [0,1,2]);
            done()
        });
    });

    it('create new resource2', function(done) {
        request(app)
        .post('/resource')
        .set('Authorization', 'Bearer '+config.sca.jwt)
        .set('Accept', 'application/json')
        .send({
            resource_id: "sda",
            name: "test resource",
            active: true,
            gids: [],
            envs: {
                "test2": 123,
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
            resource2 = res.body;
            assert(resource2.name == "test resource");
            //assert.deepEqual(resource.gids, [0,1,2]);
            done()
        });
    });

    it('should query resources by name', function(done) {
        request(app)
        .get('/resource/')
        //.set('Authorization', 'Bearer '+userjwt)
        .set('Authorization', 'Bearer '+config.sca.jwt)
        .set('Accept', 'application/json')
        .query('limit=1&find='+encodeURIComponent(JSON.stringify({"name": "test resource"})))
        .expect(200)
        .end(function(err, res) {
            if(err) return done(err);
            var resources = res.body.resources;
            /*
            assert(res.body.workflow_id == "test");
            assert(res.body.name == "test name");
            assert(res.body.desc == "test desc");
            */
            //console.dir(res.body);
            assert(res.body.count > 1);
            assert(resources.length == 1);
            //console.dir(instances[0]);
            assert(resources[0].name == "test resource");
            done();
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

    //need to set a real hpss key
    xit('ls_resource', function(done) {
        request(app)
        .get('/resource/ls/'+resource._id+"?path="+encodeURIComponent("/tmp"))
        .set('Authorization', 'Bearer '+config.sca.jwt)
        .set('Accept', 'application/json')
        .end(function(err, res) {
            if(err) return done(err);
            console.log("got ls listing ");
            //console.dir(res.body);
            done();            
        });
    });

    it('delete the test resource 1', function(done) {
        request(app)
        .delete('/resource/'+resource._id)
        .set('Authorization', 'Bearer '+config.sca.jwt)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/) 
        .expect(200, done);
    });

    it('delete the test resource 2', function(done) {
        request(app)
        .delete('/resource/'+resource2._id)
        .set('Authorization', 'Bearer '+config.sca.jwt)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/) 
        .expect(200, done);
    });


    it('generate sshkey', function(done) {
        request(app)
        .get('/resource/gensshkey')
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/) 
        .expect(200, done);
    });
});

