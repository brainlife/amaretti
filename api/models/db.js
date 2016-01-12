'use strict';

//node
//var crypto = require('crypto');

//contrib
var mongoose = require('mongoose');
var winston = require('winston');

//mine
var config = require('../config');
var logger = new winston.Logger(config.logger.winston);

exports.init = function(cb) {
    mongoose.connect(config.mongodb, {}, function(err) {
        if(err) return cb(err);
        console.log("connected to mongo");
        cb();
    });
}
exports.disconnect = function(cb) {
    mongoose.disconnect(cb);
}

///////////////////////////////////////////////////////////////////////////////////////////////////

var workflowSchema = mongoose.Schema({
    ///////////////////////////////////////////////////////////////////////////////////////////////
    //key
    user_id: {type: String, index: true}, 
    //
    //////////////////////////////////////////////////////////////////////////////////////////////

    name: String, 
    desc: String, 

    steps: [ mongoose.Schema({
        service_id: String,
        name: String,  //not sure if I will ever use this
        config: mongoose.Schema.Types.Mixed,

        tasks: [ {type: mongoose.Schema.Types.ObjectId, ref: 'Task'}],
        //products: [ {type: mongoose.Schema.Types.ObjectId, ref: 'Product'}],

        //not sure how useful / accurate these will be..
        create_date: {type: Date, default: Date.now },
        //update_date: {type: Date, default: Date.now },
    }) ] ,

    create_date: {type: Date, default: Date.now },
    update_date: {type: Date, default: Date.now },
});
workflowSchema.pre('update', function(next) {
    this.update_date = new Date();
    next();
});
exports.Workflow = mongoose.model('Workflow', workflowSchema);

///////////////////////////////////////////////////////////////////////////////////////////////////

var resourceSchema = mongoose.Schema({
    ////////////////////////////////////////////////
    //key
    user_id: {type: String, index: true}, 
    type: String, //like hpss, pbs, 
    resource_id: String, //like sda, bigred2
    //
    ////////////////////////////////////////////////

    name: String, 
    config: mongoose.Schema.Types.Mixed,
    salts: mongoose.Schema.Types.Mixed, //salts used to encrypt fields in config

    create_date: {type: Date, default: Date.now },
    update_date: {type: Date, default: Date.now },
});

//mongoose's pre/post are just too fragile.. it gets call on some and not on others.. (like findOneAndUpdate)
//I prefer doing this manually anyway, because it will be more visible 
resourceSchema.pre('update', function(next) {
    //this._update.$set.update_date = new Date();
    this.update_date = new Date();
    next();
});
/*
resourceSchema.pre('update', function(next) {
    console.log("pre update");
    encrypt_config(this._update.$set.config);
    this._update.$set.update_date = new Date();
    next();
});
resourceSchema.pre('save', function(next) {
    console.log("pre save");
    encrypt_config(this.config);
    next();
});
resourceSchema.post('find', function(doc) {
    console.log("pre find");
    if(doc.config) decrypt_config(doc.config);
});
*/

/*
function encrypt_config(_config, cb) { 
    //create new salt/iv
    var salt = new Buffer(crypto.randomBytes(32)); //ensure that the IV (initialization vector) is random
    var iv = new Buffer(crypto.randomBytes(16)); //ensure that the IV (initialization vector) is random
    _config._enc_salt = salt;
    _config._enc_iv = iv;
    var key = crypto.pbkdf2Sync(config.sca.resource_enc_password, salt, 100000, 32, 'sha512');//, config.sca.resource_pbkdf2_algo);
    var cipher = crypto.createCipheriv('aes256', key, iv);
    for(var k in _config) {
        if(k.indexOf("enc_") === 0) {
            console.dir(k);
            console.dir(_config[k]);
            _config[k] = cipher.update(_config[k], 'utf8', 'base64');
            _config[k] += cipher.final('base64');
        }
    }
}

//decrypt all config parameter that starts with enc_
function decrypt_config(_config) {
    if(!_config._enc_salt || !_config._enc_iv) {
        logger.error("_end_salt or _enc_iv is missing.. can't decrypt config");
        return;
    }
    var key = crypto.pbkdf2Sync(config.sca.resource_enc_password, _config._enc_salt, 100000, 32, 'sha512');//, config.sca.resource_pbkdf2_algo);
    var decipher = crypto.createDecipheriv(config.sca.resource_algo, key, _config._enc_iv);
    for(var k in _config) {
        if(k.indexOf("enc_") === 0) {
            _config[k] = decipher.update(_config[k], 'base64', 'utf8');
            _config[k] += decipher.final('utf8'); 
        }
    }
}
*/

exports.Resource = mongoose.model('Resource', resourceSchema);

///////////////////////////////////////////////////////////////////////////////////////////////////

var taskSchema = mongoose.Schema({
    ///////////////////////////////////////////////////////////////////////////////////////////////
    //important fields
    workflow_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Workflow'},
    step_idx: Number, //index of step within workflow
    //task_id: Number, //index of task within step
    user_id: String, //sub of user submitted this request
    //
    //////////////////////////////////////////////////////////////////////////////////////////////

    name: String,
    service_id: String,
    progress_key: {type: String, index: true}, 
    status: String, 

    //resources used by this task
    resources: mongoose.Schema.Types.Mixed, 
    
    //object containing details for this request
    config: mongoose.Schema.Types.Mixed, 

    //dependencies required to run the service
    //[ {type: "product", env: "FASTA", task_id: "1231231231312321"} ]
    deps: [ mongoose.Schema.Types.Mixed ],

    //fs: String, //.. like "uits_dc2"
    //workdir: String, //.. like "/N/dc2/scratch/__username__/sca/workflows/__workflowid__/"
    //taskdir: String, //.. like "hpss.123351723984123424"
    products: [ mongoose.Schema.Types.Mixed ],

    create_date: {type: Date, default: Date.now },
    update_date: {type: Date, default: Date.now },
});
taskSchema.pre('update', function(next) {
    this.update_date = new Date();
    next();
});
exports.Task = mongoose.model('Task', taskSchema);

///////////////////////////////////////////////////////////////////////////////////////////////////

/*
//DEPRECATED
var productSchema = mongoose.Schema({
    ///////////////////////////////////////////////////////////////////////////////////////////////
    //important fields
    workflow_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Workflow'},
    user_id: String, //sub of user submitted this request
    //
    //////////////////////////////////////////////////////////////////////////////////////////////

    //task that created this product (maybe not set if it wasn't generated by a task)
    task_id: {type: mongoose.Schema.Types.ObjectId, ref: 'Task'},
    service_id: String, //service that produced this product

    name: String, //what for?

    //resources used to produce this product
    resources: mongoose.Schema.Types.Mixed, 

    //fs: String, //filesystem ..TODO
    path: String, //path where this product is stored .. like "/N/dc2/scratch/__username__/sca/workflows/__workflowid__/"
    
    //object containing details for this product
    detail: mongoose.Schema.Types.Mixed, 

    create_date: {type: Date, default: Date.now },
    update_date: {type: Date, default: Date.now }, //I am not sure if product ever get updated?
});
productSchema.pre('update', function(next) {
    this.update_date = new Date();
    next();
});
exports.Product = mongoose.model('Product', productSchema);
*/
