'use strict';

//contrib
var request = require('supertest')
var assert = require('assert');
var fs = require('fs');

//mine
var config = require('../config');
var db = require('../api/models/db');
var app = require('../api/server').app;

/*
console.log("dumping sca.auth_pubkey");
console.log("##"+config.sca.auth_pubkey.toString()+"##");

console.log("dumping jwt");
console.log("##"+config.sca.jwt.toString()+"##");
*/

//config.sca.jwt is admin token.. if I want to test as normal user, I need to use userjwt
var userjwt = fs.readFileSync(__dirname+'/config/user.jwt');

describe('/instance', function() {
    var instance = null;
    it('should create instance 1', function(done) {
        request(app)
        .post('/instance')
        .set('Authorization', 'Bearer '+userjwt)
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
        .set('Authorization', 'Bearer '+userjwt)
        //.set('Authorization', 'Bearer '+config.sca.jwt)
        .set('Accept', 'application/json')
        .send({
            workflow_id: "test",    
            user_id: "hacker", //should be ignored!
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
            console.dir(instance);
            assert(instance2.workflow_id == "test");
            assert(instance2.name == "test 2");
            assert(instance2.desc == "test desc 2");
            assert(instance2.user_id == "test_user"); //shouldn't be hacker!
            done();
        });
    });
    it('should create instance 3 as admin - to test admin query later', function(done) {
        request(app)
        .post('/instance')
        //.set('Authorization', 'Bearer '+userjwt)
        .set('Authorization', 'Bearer '+config.sca.jwt)
        .set('Accept', 'application/json')
        .send({
            workflow_id: "test",    
            name: "admin test instance", 
            config: {
                what: "ever"
            }
        })  
        .expect(200)
        .end(function(err, res) {
            if(err) return done(err);
            let instance3 = res.body;
            assert(instance3.workflow_id == "test");
            assert(instance3.name == "admin test instance");
            done();
        });
    });
    /* this api is now deprecated
    it('should find a single instance by id', function(done) {
        request(app)
        .get('/instance/'+instance._id)
        .set('Authorization', 'Bearer '+config.sca.jwt)
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
    */
    it('should query instances by workflow_id', function(done) {
        request(app)
        .get('/instance/')
        .set('Authorization', 'Bearer '+userjwt)
        //.set('Authorization', 'Bearer '+config.sca.jwt)
        .set('Accept', 'application/json')
        .query('limit=1&find='+encodeURIComponent(JSON.stringify({"workflow_id": "test"})))
        .expect(200)
        .end(function(err, res) {
            if(err) return done(err);
            var instances = res.body.instances;
            /*
            assert(res.body.workflow_id == "test");
            assert(res.body.name == "test name");
            assert(res.body.desc == "test desc");
            */
            assert(res.body.count > 1);
            assert(instances.length == 1);
            //console.dir(instances[0]);
            assert(instances[0].name == "test");
            done();
        });
        
    });
    it('should query instances by config - and limit 1', function(done) {
        request(app)
        .get('/instance')
        .query('limit=1&find='+encodeURIComponent(JSON.stringify({"config.what": "ever", user_id: "should be ignored"})))
        .set('Authorization', 'Bearer '+userjwt)
        //.set('Authorization', 'Bearer '+config.sca.jwt)
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
        .set('Authorization', 'Bearer '+userjwt)
        //.set('Authorization', 'Bearer '+config.sca.jwt)
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

    it('should query all users instances as admin with user_id:null(', function(done) {
        request(app)
        .get('/instance')
        .query('find='+encodeURIComponent(JSON.stringify({user_id: null})))
        //.set('Authorization', 'Bearer '+userjwt)
        .set('Authorization', 'Bearer '+config.sca.jwt)
        .set('Accept', 'application/json')
        .expect(200)
        .end(function(err, res) {
            if(err) return done(err);
            var instances = res.body.instances;
            var user_ids = [];
            instances.forEach(function(instance) {
                //console.log(instance._id);
                //console.log(instance.user_id);
                if(!~user_ids.indexOf(instance.user_id)) user_ids.push(instance.user_id);
            });
            assert(user_ids.length > 1); //should be more than 1
            done();
        });
    });
    it('should query instances as admin with user_id:undefined', function(done) {
        request(app)
        .get('/instance')
        //.query('find='+encodeURIComponent(JSON.stringify({user_id: null})))
        //.set('Authorization', 'Bearer '+userjwt)
        .set('Authorization', 'Bearer '+config.sca.jwt)
        .set('Accept', 'application/json')
        .expect(200)
        .end(function(err, res) {
            if(err) return done(err);
            var instances = res.body.instances;
            var user_ids = [];
            instances.forEach(function(instance) {
                //console.log(instance._id);
                //console.log(instance.user_id);
                if(!~user_ids.indexOf(instance.user_id)) user_ids.push(instance.user_id);
            });
            //console.dir(user_ids);
            //should only find "sca" user
            assert(user_ids.length == 1);
            assert(user_ids[0] == "sca");
            done();
        });
    });
    it('should query instances as admin with user_id:"test_user"', function(done) {
        request(app)
        .get('/instance')
        .query('find='+encodeURIComponent(JSON.stringify({user_id: "test_user"})))
        //.set('Authorization', 'Bearer '+userjwt)
        .set('Authorization', 'Bearer '+config.sca.jwt)
        .set('Accept', 'application/json')
        .expect(200)
        .end(function(err, res) {
            if(err) return done(err);
            var instances = res.body.instances;
            var user_ids = [];
            instances.forEach(function(instance) {
                //console.log(instance._id);
                //console.log(instance.user_id);
                if(!~user_ids.indexOf(instance.user_id)) user_ids.push(instance.user_id);
            });
            //console.dir(user_ids);
            //should only find "sca" user
            assert(user_ids.length == 1);
            assert(user_ids[0] == "test_user");
            done();
        });
    });
});


