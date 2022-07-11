'use strict';

//contrib
const request = require('supertest')
const assert = require('assert');
const fs = require('fs');

//mine
const config = require('../api/config');
const db = require('../api/models');
const app = require('../api/server').app;

const service = require('../api/service');

//console.log(JSON.stringify(config, null, 4));

/*
before(function(done) {
    console.log("connecting to mongodb");
    this.timeout(10000);
    db.init(function(err) {
        if(err) return done(err);
        done();
    });
});
*/

describe.skip('GET /health', function() {
    it('return 200', function(done) {
        request(app)
        .get('/health')
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/) 
        .end(function(err, res) {
            if (err) throw err;
            assert(res.body.status == "failed", "initial status should be failed");
            done();
        });
    });
});

/*
describe('/common/service', function() {
    it('get_sha', function(done) {
        service.get_sha("brain-life/app-life", "1.9", (err, res)=>{
            if(err) return done(err);
            console.dir(res);
            assert(res.sha == "422ac44998012b4da38c05fcef005f75615f7789");
            done();
        });
    });
});
*/

/*
after(function(done) {
    console.log("all done.. disconnecting db");
    db.disconnect();
    done();
});
*/


