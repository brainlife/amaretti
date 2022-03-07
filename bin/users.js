#!/usr/bin/env node
//cronjob script to ingest openneuro datasets as brainlife projects

const mongoose = require("mongoose");
const axios = require('axios');
const fs = require('fs');

const config = require("../config");
const db = require('../api/models');

db.init(async err=>{
    if(err) throw err;

    const headers = { "Authorization": "Bearer "+config.amaretti.jwt }

    /*
    {
      _id: '60e72d4a70d8617090708464',
      email_confirmed: true,
      active: true,
      scopes: { brainlife: [ 'user' ] },
      profile: {
        public: { institution: 'Guest User', showOnMap: false },
        private: { position: 'Guest', aup: true },
        admin: {}
      },
      sub: 37,
      times: {
        register: '2021-07-08T16:52:26.165Z',
        confirm_email: '2021-07-08T16:53:42.438Z',
        local_login: '2021-07-08T16:54:54.644Z'
      },
      username: 'guest+7',
      fullname: 'Guest 7',
      email: 'hayashis+7@iu.edu',
      ext: { openids: [], x509dns: [] }
    }
    */

    //get list of all active users
    const users = await axios.get("https://dev1.soichi.us/api/auth/users", {headers});
    for await (const user of users.data.users) {

        //count number of jobs submitted by this user
        user.tasks = await db.Task.aggregate([
            {$match: {
                user_id: user.sub.toString(),
            }},

            {
                $group: {
                    _id: {groupId: "$_group_id"},
                    count: {$sum: 1},
                    walltime: {$sum: "$runtime"},
                }
            }
        ]);

        user.profile.private = "removed";
        console.dir(user);
    }

    console.log(JSON.stringify(users.data.users));

    fs.writeFileSync("users.json", JSON.stringify(users.data.users, null, 4));

    db.disconnect();

    /*
    let projects = await db.Projects.find({openneuro: {$exists: true}}).select('_id');
    let project_ids = projects.map(project=>project._id.toString());
    console.dir(project_ids.length, "projects");

    //query all tasks that used datasets from openneuro project ids
    let res = await rp.get({
        url: config.amaretti.api+"/task", json: true,
        headers: { authorization: "Bearer "+config.warehouse.jwt},
        qs: {
        find: JSON.stringify({
            "config.datasets.project": {$in: project_ids},
            "user_id": {$nin: [1, 41]},
        }),
        limit: 20000,
        select: 'user_id service config.datasets.project',
        },
    });
    res.tasks.forEach(task=>{
        console.log(task._id, task.user_id, task.service, task.config);
    });
    */
}, false);
