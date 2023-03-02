const config = require('../config');
const api_transfer = require('../api/transfer.js');
const common = require('../api/common.js');
const db = require('../api/models.js');
const transfer = require('../api/transfer.js');

console.log("querying test resource");
db.init(async err=>{
    if(err) throw err;

    //let src_resource = await db.Resource.findById("59ea931df82bb308c0197c3d");//wrangler
    let src_resource = await db.Resource.findById("5dc37e2679401a5d0ae34a55");//hayashis@bigred3
    /*
    let src_path = "/home/04040/hayashis/tmp/test";

    let dest_resource = await db.Resource.findById("59cbc0603199680e9d12a8ff");//js-slurm2
    let dest_path = "/tmp/test";

    transfer.rsync_resource(src_resource, dest_resource, src_path, dest_path, cb=>{ console.log("progress.."); }, err=>{
        if(err) throw err;
        console.log("done");
    });
    */
    for(let i = 0;i < 1;++i) {
        common.get_ssh_connection(src_resource, (err, conn)=>{
            if(err) throw err;

            //console.log("closing connection");
            //conn.end();

            console.log(i, "running exec");
            conn.exec("bash -c \"exit 5\"", (err, stream)=>{
                if(err) throw err;
                stream.on('close', function(code, sig) {
                    console.log(i, "stream close");
                    if(code == undefined) console.log("code undefined!")
                    else console.log(i, code);
                })
                .on('data', data=>{
                    console.log(data.toString());
                }).stderr.on('data', data=>{
                    console.error(data.toString());
                })
                //stream.write("hello");
                //stream.end();
            });
        });
    }
});
