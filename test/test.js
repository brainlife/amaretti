'use strict';

//contrib
var request = require('supertest')
var assert = require('assert');
var fs = require('fs');

//mine
var config = require('../config');
var db = require('../api/models/db');
var app = require('../api/server').app;

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


