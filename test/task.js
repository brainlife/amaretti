'use strict';

//contrib
var request = require('supertest')
var assert = require('assert');
var fs = require('fs');

//mine
var config = require('./config');
var db = require('../api/models/db');
var app = require('../api/server').app;

describe('/task', function() {
    var instance = null;
    var task = null;

    before(function(done) {
        request(app)
        .get('/instance/')
        .set('Authorization', 'Bearer '+config.sca.jwt)
        .set('Accept', 'application/json')
        .query('limit=1&find='+encodeURIComponent(JSON.stringify({"workflow_id": "test"})))
        .expect(200)
        .end(function(err, res) {
            if(err) return done(err);
            var instances = res.body.instances;
            if(instances.length == 0) {
                console.log("creating new test instance");
                request(app)
                .post('/instance')
                .set('Authorization', 'Bearer '+config.sca.jwt)
                .set('Accept', 'application/json')
                .send({
                    workflow_id: "test",    
                    user_id: "testuser",        
                    name: "test 2", 
                    desc: "test desc 2",    
                    config: {
                        what: "ever"
                    }
                })  
                .expect(200)
                .end(function(err, res) {
                    if(err) return done(err);
                    instance = res.body;
                    done();
                });
            } else {
                instance = instances[0];
                done();
            }
        });
    });

    it('should not create task with missing resource_dep', function(done) {
        request(app)
        .post('/task')
        .set('Authorization', 'Bearer '+config.sca.jwt)
        .set('Accept', 'application/json')
        .send({
                name: "test",   
                desc: "test desc",      
                instance_id: instance._id,
                service: "soichih/sca-service-noop",
                config: {
                        what: "ever"
                },
                resource_deps: ["5760192fa6b6070a731af134"]
        })  
        .expect(500)
        .end(function(err, res) {
            if(err) return done(err);
            done();
        });
    });

    it('should not create task with resource preference set to missing resource', function(done) {
        request(app)
        .post('/task')
        .set('Authorization', 'Bearer '+config.sca.jwt)
        .set('Accept', 'application/json')
        .send({
                name: "test",   
                desc: "test desc",      
                instance_id: instance._id,
                service: "soichih/sca-service-noop",
                config: {
                        what: "ever"
                },
                preferred_resource_id: "5760192fa6b6070a731af134",
        })  
        .expect(500)
        .end(function(err, res) {
            if(err) return done(err);
            done();
        });
    });

    it('should create a task', function(done) {
        request(app)
        .post('/task')
        .set('Authorization', 'Bearer '+config.sca.jwt)
        .set('Accept', 'application/json')
        .send({
                name: "test",   
                desc: "test desc",      
                instance_id: instance._id,
                group_id: "ahoi",
                service: "soichih/sca-service-noop",
                config: {
                        what: "ever"
                },
        })  
        .expect(200)
        .end(function(err, res) {
            if(err) return done(err);
            task = res.body.task;            
            assert(task.progress_key == "_sca."+instance._id+".ahoi."+task._id); //make sure group id is added
            //console.dir(task);
            done();
        });
    });

    it('should update a task', function(done) {
        request(app)
        .put('/task/'+task._id)
        .set('Authorization', 'Bearer '+config.sca.jwt)
        .set('Accept', 'application/json')
        .send({
                name: "test 2",   
                desc: null,
                instance_id: "123",
                user_id: "123",
        })  
        .expect(200)
        .end(function(err, res) {
            if(err) return done(err);
            var task2 = res.body;            
            assert(task2.name == "test 2"); //should be new
            assert(task2.desc == undefined); //should be reset
            assert(task2.instance_id == task.instance_id); //should remain the same
            assert(task2.user_id == task.user_id); //should remain the same
            done();
        });
    });

    it('should remove a task', function(done) {
        request(app)
        .delete('/task/'+task._id)
        .set('Authorization', 'Bearer '+config.sca.jwt)
        .set('Accept', 'application/json')
        .expect(200)
        .end(function(err, res) {
            if(err) return done(err);
            done();
        });
    });
});
