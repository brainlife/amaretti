
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

/*
var workflowStepSchema = mongoose.Schema({ 
    step: mongoose.Schema.Types.Mixed,
});
*/
var workflowSchema = mongoose.Schema({
    ///////////////////////////////////////////////////////////////////////////////////////////////
    //key
    user_id: {type: String, index: true}, 
    //
    //////////////////////////////////////////////////////////////////////////////////////////////

    name: String, 
    desc: String, 
    steps: [ mongoose.Schema.Types.Mixed ], 

    create_date: {type: Date, default: Date.now },
    update_date: {type: Date, default: Date.now },
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

    create_date: {type: Date, default: Date.now },
    update_date: {type: Date, default: Date.now },
});
exports.Resource = mongoose.model('Resource', resourceSchema);

///////////////////////////////////////////////////////////////////////////////////////////////////

var taskSchema = mongoose.Schema({
    ///////////////////////////////////////////////////////////////////////////////////////////////
    //key
    workflow_id: mongoose.Schema.Types.ObjectId,
    user_id: String, //sub of user submitted this request
    //
    //////////////////////////////////////////////////////////////////////////////////////////////

    progress_id: {type: String, index: true}, 
    status: String, 
    
    //object containing details for this request
    config: mongoose.Schema.Types.Mixed, 

    create_date: {type: Date, default: Date.now },
    update_date: {type: Date, default: Date.now },
});
exports.Task = mongoose.model('Task', taskSchema);

///////////////////////////////////////////////////////////////////////////////////////////////////


/*
var researchSchema = mongoose.Schema({
    ///////////////////////////////////////////////////////////////////////////
    //
    // keys
    //
    IIBISID: String, //like.. 2016-00001
    Modality: String,  //like.. PT
    StationName: String,  //like.. CT71271
    radio_tracer: String, //like DOTA NOC (from RadiopharmaceuticalInformationSequence.Radiopharmaceutical - only used for CT)
    //
    ///////////////////////////////////////////////////////////////////////////

});

exports.Research = mongoose.model('Research', researchSchema);

var templateSchema = mongoose.Schema({
    ///////////////////////////////////////////////////////////////////////////
    //
    // keys
    //
    research_id: {type: mongoose.Schema.Types.ObjectId, index: true}, 
    //study_id: {type: mongoose.Schema.Types.ObjectId, index: true}, 
    series_desc: String, //original SeriesDescription minut anything after ^
    //series_id: {type: mongoose.Schema.Types.ObjectId, index: true}, 
    date: Date, //date when this template is received (probabbly use StudyTimestamp of the template?)
    SeriesNumber: Number,
    
    //
    ///////////////////////////////////////////////////////////////////////////
    
    ///////////////////////////////////////////////////////////////////////////
    //
    //foreign key to assist lookup
    //
    Modality: String,  //like.. PT
    
    count: Number, //number of images in a given series
});
exports.Template = mongoose.model('Template', templateSchema);

///////////////////////////////////////////////////////////////////////////////////////////////////

var templateHeaderSchema = mongoose.Schema({
    ///////////////////////////////////////////////////////////////////////////
    //
    // keys
    //
    template_id: {type: mongoose.Schema.Types.ObjectId, index: true}, 
    AcquisitionNumber: Number,
    InstanceNumber: Number,
    //
    ///////////////////////////////////////////////////////////////////////////
    
    headers: mongoose.Schema.Types.Mixed, 
    IIBISID: String, //make it easier to do access control
    
});
exports.TemplateHeader = mongoose.model('TemplateHeader', templateHeaderSchema);

///////////////////////////////////////////////////////////////////////////////////////////////////

var studySchema = mongoose.Schema({
    ///////////////////////////////////////////////////////////////////////////
    //
    // keys
    //
    research_id: {type: mongoose.Schema.Types.ObjectId, index: true}, 
    series_desc: String, //original SeriesDescription minut anything after ^
    subject: String,
    StudyInstanceUID: String, //StudyInstanceUID alone can not uniquely identify a "study" as I understand it. 
    SeriesNumber: Number, //some study has repeated series
    //
    ///////////////////////////////////////////////////////////////////////////
    
    ///////////////////////////////////////////////////////////////////////////
    //
    //foreign key/value to assist lookup
    //
    Modality: String,  //like.. PT
    StudyTimestamp: Date,
    IIBISID: String,  //for easy access control

    ///////////////////////////////////////////////////////////////////////////

    //template to use for QC (if not, latest version will be used) specified by a user - to override the auto selection
    template_id: {type: mongoose.Schema.Types.ObjectId, index: true},

    //study level qc result 
    qc: mongoose.Schema.Types.Mixed,
});

exports.Study = mongoose.model('Study', studySchema);

///////////////////////////////////////////////////////////////////////////////////////////////////
///
var acquisitionSchema = mongoose.Schema({

    ///////////////////////////////////////////////////////////////////////////
    //
    // keys
    //
    //study that this aq belongs to
    study_id: {type: mongoose.Schema.Types.ObjectId, index: true}, 
    AcquisitionNumber: Number,
    //
    ///////////////////////////////////////////////////////////////////////////
    
    ///////////////////////////////////////////////////////////////////////////
    //
    //foreign key to assist lookup
    //
    research_id: {type: mongoose.Schema.Types.ObjectId, index: true}, 
    study_id: {type: mongoose.Schema.Types.ObjectId, index: true}, 
});
exports.Acquisition = mongoose.model('Acquisition', acquisitionSchema);

///////////////////////////////////////////////////////////////////////////////////////////////////

var imageSchema = mongoose.Schema({
    
    ///////////////////////////////////////////////////////////////////////////////////////////////
    //key
    //SOPInstanceUID: String,
    acquisition_id: {type: mongoose.Schema.Types.ObjectId, index: true}, 
    InstanceNumber: Number,
    //
    ///////////////////////////////////////////////////////////////////////////////////////////////

    //foreigh keys to make it easier to find related information
    research_id: {type: mongoose.Schema.Types.ObjectId, index: true}, 
    study_id: {type: mongoose.Schema.Types.ObjectId, index: true}, 
    IIBISID: String,  //for easy access control

    //the actual headers for this instance (cleaned)
    headers: mongoose.Schema.Types.Mixed, 

    //qc result (null if not qc-ed)
    qc: mongoose.Schema.Types.Mixed,
});
exports.Image = mongoose.model('Image', imageSchema);

///////////////////////////////////////////////////////////////////////////////////////////////////

var aclSchema = mongoose.Schema({
    ///////////////////////////////////////////////////////////////////////////////////////////////
    //key
    //SOPInstanceUID: String,
    key: String,
    //
    //////////////////////////////////////////////////////////////////////////////////////////////
    value: mongoose.Schema.Types.Mixed, 
});
aclSchema.statics.canAccessIIBISID = function(user, iibisid, cb) {
    this.findOne({key: 'iibisid'}, function(err, acl) {
        var _acl = acl.value[iibisid];
        if(!_acl) return cb(false); //not set
        return cb(~_acl.users.indexOf(user.sub));
    });
};
exports.Acl = mongoose.model('Acl', aclSchema);
*/
