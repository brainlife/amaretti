#!/usr/bin/env node

const mongoose = require("mongoose");
const axios = require('axios');
const fs = require('fs');

const config = require('../api/config');
const db = require('../api/models');

db.init(async err=>{
    if(err) throw err;

    for (let year = 2017; year <= 2022; ++year) {
    //for (let year = 2022; year <= 2022; ++year) {
        for (let month = 1; month <= 12; ++month) {
            const start = new Date(year+"-"+month+"-01");
            const end = new Date(start);
            end.setMonth(end.getMonth()+1);
            await report(start, end);
        }
    }
    db.disconnect();

}, false);

async function report(start, end) {

    const rangeName = start.getFullYear()+"-"+(start.getMonth()+1) + "." + end.getFullYear()+"-"+(end.getMonth()+1);
    console.log("querying ", rangeName);

    //const headers = { "Authorization": "Bearer "+config.amaretti.jwt }

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
    /*
    console.log("users--------------");
    const params = {
        limit: 5000,
        find: JSON.stringify({
            active: true,
        }),
    };
    const users = await axios.get("https://brainlife.io/api/auth/users", {headers, params});
    let count = 0;
    */
    const tasks = {};

    const users = await db.Task.aggregate([
        {$match: {
            //user_id: user.sub.toString(),
            create_date: {$gte: start, $lt: end},
        }},

        {
            $group: {
                _id: {userId: "$user_id"},
                count: {$sum: 1},
                walltime: {$sum: "$runtime"},
            }
        }
    ]);
    /*
[
  { _id: { userId: '16' }, count: 24, walltime: 0 },
  { _id: { userId: '19' }, count: 13, walltime: 0 },
  { _id: { userId: '25' }, count: 18, walltime: 0 },
  { _id: { userId: '1' }, count: 398, walltime: 0 },
  { _id: { userId: '14' }, count: 51, walltime: 0 },
  { _id: { userId: '18' }, count: 108, walltime: 0 },
  { _id: { userId: '20' }, count: 2, walltime: 0 },
  { _id: { userId: '22' }, count: 9, walltime: 0 },
  { _id: { userId: '17' }, count: 84, walltime: 0 },
  { _id: { userId: '23' }, count: 9, walltime: 0 }
]

    */
    const services = await db.Task.aggregate([
        {$match: {
            //user_id: user.sub.toString(),
            create_date: {$gte: start, $lt: end},
        }},

        {
            $group: {
                _id: {service: "$service"},
                count: {$sum: 1},
                walltime: {$sum: "$runtime"},
            }
        }
    ]);

    const groups = await db.Task.aggregate([
        {$match: {
            create_date: {$gte: start, $lt: end},
        }},

        {
            $group: {
                _id: {groupId: "$_group_id"},
                count: {$sum: 1},
                walltime: {$sum: "$runtime"},
            }
        }
    ]);

    const resources = await db.Task.aggregate([
        {$match: {
            create_date: {$gte: start, $lt: end},
        }},

        {
            $group: {
                _id: {resourceId: "$resource_id"},
                count: {$sum: 1},
                walltime: {$sum: "$runtime"},
            }
        }
    ]);
    const resourcesPop = await db.Resource.populate(resources, {path: "_id.resourceId"});

    const novncs = await db.Task.aggregate([
        {$match: {
            create_date: {$gte: start, $lt: end},
            service: "brainlife/abcd-novnc",
        }},

        {
            $group: {
                _id: {/*userId: "$user_id",*/type: "$config.type"},
                count: {$sum: 1},
                //walltime: {$sum: "$runtime"},
            }
        }
    ]);

    //console.log(JSON.stringify(users.data.users));
    tasks.totalJobCount = users.reduce((a,v)=>a+v.count, 0);
    tasks.totalWalltime = users.reduce((a,v)=>a+v.walltime, 0);
    tasks.totalUsers = users.length;
    tasks.totalServices = services.length;
    tasks.totalGroups = groups.length;
    tasks.totalResources = resourcesPop.length;

    tasks.byUsers = users.map(u=>({
        sub: u._id.userId,
        jobCount: u.count,
        jobWalltime: u.walltime,
    }));

    tasks.byServices = services.map(s=>({
        service: s._id.service,
        jobCount: s.count,
        jobWalltime: s.walltime,
    }));

    tasks.byGroup = groups.map(s=>({
        groupId: s._id.groupId,
        jobCount: s.count,
        jobWalltime: s.walltime,
    }));

    tasks.byResources = resourcesPop.map(s=>({
        resourceId: (s._id.resourceId?s._id.resourceId._id.toString():null),
        resourceName: (s._id.resourceId?s._id.resourceId.name:null),
        jobCount: s.count,
        jobWalltime: s.walltime,
    }));

    tasks.visByType = novncs.map(s=>({
        type: s._id.type,
        jobCount: s.count,
    }));

    console.dir(tasks);
    fs.writeFileSync("/output/tasks."+rangeName+".json", JSON.stringify(tasks, null, 4));

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
}

