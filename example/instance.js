var request = require('request');
var fs = require('fs');
var sca = "https://soichi7.ppa.iu.edu/api";

//update to point to your sca jwt (see login page for more info)
var jwt = fs.readFileSync('/home/hayashis/.sca/keys/cli.jwt', {encoding: 'ascii'}).trim();

request.post({
    url: sca+"/wf/instance",
    json: true,
    headers: { 'Authorization': 'Bearer '+jwt },
    body: {
        //workflow_id: 'ahoi',
        name: 'here is my test instance',
        desc: 'mytest',
        config: {
            type: "test",
        }
    }, 
}, function(err, res, body) {
    if(err) throw err;
    if(res.statusCode != 200) throw new Error(body);
    console.dir(body);
});

