
//contrib
var request = require('supertest')
var assert = require('assert');
var fs = require('fs');

//mine
var config = require('../config');
var db = require('../api/models/db');
var app = require('../api/server').app;

var jwt = fs.readFileSync("./config/sca.jwt");

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

describe('/instance', function() {
    it('should create instance', function(done) {
	request(app)
	.post('/instance')
        .set('Authorization', 'Bearer '+jwt)
        .set('Accept', 'application/json')
	.send({
		workflow_id: "test",	
		user_id: "test_service",	
		name: "test name",	
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
		console.dir(res.body);
		assert(res.body.workflow_id == "test");
		assert(res.body.name == "test name");
		assert(res.body.desc == "test desc");
		done();
	});
    });
});

