'use strict';

const axios = require('axios')
const config = require('../config');

let days = 30*100;
const resource_id = "594c4d88cec9aa163acb9264";
axios.get(config.metrics.api+"/render", {
    params: {
        target: config.metrics.resource_prefix+"."+resource_id,
        from: "-"+days+"day",
        format: "json",
        noNullPoints: "true"
    }
}).then(res=>{
    console.dir(res.data);
    console.log(res.data[0].datapoints[0]);
});

