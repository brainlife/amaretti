'use strict';

//contrib
var request = require('supertest')
var assert = require('assert');
var fs = require('fs');

//mine
var config = require('../config');
var db = require('../api/models/db');
var app = require('../api/server').app;

var jwt = fs.readFileSync(__dirname+"/../config/sca.jwt");

before(function(done) {
    console.log("connecting to mongodb");
    this.timeout(10000);
    db.init(function(err) {
        if(err) return done(err);
        done();
    });
});

describe('GET /health', function() {
    it('return 200', function(done) {
        request(app)
        .get('/health')
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/) 
        .expect(200, done);
    });
});

describe('/resource', function() {
    var resource = null;

    it('create new resource', function(done) {
        request(app)
        .post('/resource')
        .set('Authorization', 'Bearer '+jwt)
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
        .set('Authorization', 'Bearer '+jwt)
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
        .set('Authorization', 'Bearer '+jwt)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/) 
        .expect(200, done);
    });
});

describe('/instance', function() {
    var instance = null;
    it('should create instance 1', function(done) {
        request(app)
        .post('/instance')
        .set('Authorization', 'Bearer '+jwt)
        .set('Accept', 'application/json')
        .send({
                workflow_id: "test",    
                user_id: "test_service",        
                name: "test",   
                desc: "test desc",      
                config: {
                        what: "ever"
                }
        })  
        /*
        .expect(200, {
                workflow_id: "test"
        }, done);
        /*
        */
        .expect(200)
        .end(function(err, res) {
                if(err) return done(err);
                instance = res.body;
                assert(instance.workflow_id == "test");
                assert(instance.name == "test");
                assert(instance.desc == "test desc");
                done();
        });
    });
    it('should create instance 2', function(done) {
        request(app)
        .post('/instance')
        .set('Authorization', 'Bearer '+jwt)
        .set('Accept', 'application/json')
        .send({
                workflow_id: "test",    
                user_id: "test_service",        
                name: "test 2", 
                desc: "test desc 2",    
                config: {
                        what: "ever"
                }
        })  
        .expect(200)
        .end(function(err, res) {
                if(err) return done(err);
                let instance2 = res.body;
                //console.dir(instance);
                assert(instance2.workflow_id == "test");
                assert(instance2.name == "test 2");
                assert(instance2.desc == "test desc 2");
                done();
        });
    });
    it('should find a single instance by id', function(done) {
        request(app)
        .get('/instance/'+instance._id)
        .set('Authorization', 'Bearer '+jwt)
        .set('Accept', 'application/json')
        .expect(200)
        .end(function(err, res) {
                if(err) return done(err);
                //console.dir(res.body);
                assert(res.body.workflow_id == "test");
                assert(res.body.name == "test");
                assert(res.body.desc == "test desc");
                done();
        });
    });
    it('should query instances by name', function(done) {
        request(app)
        .get('/instance/')
        .set('Authorization', 'Bearer '+jwt)
        .set('Accept', 'application/json')
        .query('limit=1&find='+encodeURIComponent(JSON.stringify({"name": "test"})))
        .expect(200)
        .end(function(err, res) {
                if(err) return done(err);
                var instances = res.body.instances;
                /*
                assert(res.body.workflow_id == "test");
                assert(res.body.name == "test name");
                assert(res.body.desc == "test desc");
                */
                assert(instances.length > 0);
                //console.dir(instances[0]);
                assert(instances[0].name == "test");
                done();
        });
        
    });
    it('should query instances by config - and limit 1', function(done) {
        request(app)
        .get('/instance')
        .query('limit=1&find='+encodeURIComponent(JSON.stringify({"config.what": "ever"})))
        .set('Authorization', 'Bearer '+jwt)
        .set('Accept', 'application/json')
        .expect(200)
        .end(function(err, res) {
                if(err) return done(err);
                var instances = res.body.instances;
                //console.log(instances.length);
                assert(instances.length == 1);
                //console.dir(instances[0]);
                assert(instances[0].config.what == "ever");
                done();
        });
    });
    it('should query instances and sort by name and select only name', function(done) {
        request(app)
        .get('/instance')
        //.query('limit=1&select=name%20create_dae&sort='+encodeURIComponent(JSON.stringify({create_date: 1})))
        .query('limit=1&select=name%20create_dae&sort=-create_date')
        .set('Authorization', 'Bearer '+jwt)
        .set('Accept', 'application/json')
        .expect(200)
        .end(function(err, res) {
                if(err) return done(err);
                var instances = res.body.instances;
                assert(instances.length == 1);
                console.dir(instances);
                assert(instances[0].name === "test 2");
                assert(instances[0].desc === undefined);
                done();
        });
    });
});

