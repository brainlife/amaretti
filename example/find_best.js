'use strict';

var request = require('request');
var fs = require('fs');

var sca = "https://soichi7.ppa.iu.edu/api";
var jwt = fs.readFileSync('/home/hayashis/.sca/keys/cli.jwt', {encoding: 'ascii'}).trim();

request.get({
    url: sca+"/sca/resource/best",
    json: true,
    headers: { 'Authorization': 'Bearer '+jwt },
    qs: {
        //user: "hayashis",
        //service: "soichih/sca-service-hpss",
        service: "soichih/sca-product-raw",
    }
}, function(err, res, body) {
    if(err) throw err;
    console.dir(res.statusCode + " "+res.statusMessage);
    console.dir(body);
});


