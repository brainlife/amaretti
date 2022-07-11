'use strict';

// @TODO set up the instances using docker-compose

module.exports = {
    vm: {
        type: "ssh", 
        name: "Generic VM Instance", 
        desc: "Such as Jetstream Instance",
        workdir: "/home/__username__/workflows",

        maxtask: 1,
        envs: {
            ENV: "VM",
        },
       
        services: {
            "soichih/sca-service-noop": {score: 10},
        }
    },

    cache: {
        type: "ssh",
        name: "workdir cache",
        desc: "resources uses to simply store copy of workdir",
        workdir: "/somewhere",
        services: {
        }
    },
}

