const config = require('../config');
const api_transfer = require('../api/transfer.js');
const common = require('../api/common.js');
const db = require('../api/models.js');
const transfer = require('../api/transfer.js');

console.log("querying test resource");
db.init(async err=>{
    if(err) throw err;

    let src_resource = await db.Resource.findById("59ea931df82bb308c0197c3d");//wrangler
    let src_path = "/home/04040/hayashis/tmp/test";
    //let dest_resource = await db.Resource.findById("5bad42245ca7512cb9608840");//gpu1
    let dest_resource = await db.Resource.findById("59cbc0603199680e9d12a8ff");//js-slurm2
    let dest_path = "/tmp/test";

    transfer.rsync_resource(src_resource, dest_resource, src_path, dest_path, cb=>{ console.log("progress.."); }, err=>{
        if(err) throw err;
        console.log("done");
    });
});
