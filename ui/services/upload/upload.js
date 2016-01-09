'use strict';
(function() {

//https://github.com/danialfarid/ng-file-upload
var service = angular.module('sca-service-upload', [ 'ngFileUpload' ]);
service.directive('scaStepUpload', 
['appconf', 'serverconf', 'toaster', 'Upload', 'resources',
function(appconf, serverconf, toaster, Upload, resources) {
    return {
        restrict: 'E',
        scope: {
            workflow: '=',
        }, 
        templateUrl: 'services/upload/upload.html',
        link: function(scope, element) {
            serverconf.then(function(conf) { scope.service_detail = conf.services['upload']; });
            var step_idx = scope.$parent.$index; //how accurate is this?
            scope.step = scope.workflow.steps[step_idx];
            var config = scope.step.config; //just shorthand

            scope.files = [];

            resources.find({type: "pbs"}).then(function(rs) {
                scope.compute_resources = rs;
                if(scope.compute_resources.length == 0) toaster.error("You do not have any computing resource capable of staging blast db");
                if(!config.compute_resource_id) {
                    config.compute_resource_id = scope.compute_resources[0]._id; //first one should be the best resource to default to
                    scope.$parent.save_workflow();                    
                }
                //TODO if there are more than 1 compute resources, I should let user choose it?
            });

            //for progress
            scope.loaded = null;
            scope.total = null;

            scope.upload = function() {
                scope.loaded = 0;
                scope.total = 1; //can't be 0 since it's used for denominator
                //console.dir(scope.files);
                //console.dir(scope.step.config);

                Upload.upload({
                    //TODO - pick appropriate resource_id
                    url: appconf.api+"/service/upload/files?w="+scope.workflow._id+"&s="+step_idx+"&resource_id="+scope.step.config.compute_resource_id, 
                    data: {
                        name: scope.step.config.name, 
                        type: scope.step.config.type, 
                        file: scope.files
                    }
                }).then(function(res) {
                    //console.dir(res);
                    scope.loaded = null;
                    scope.step.tasks.push(res.data.task);
                    //toaster.success("uploaded successfully");
                    scope.files = [];
                }, function(res) {
                    scope.loaded = null;
                    if(res.data && res.data.message) toaster.error(res.data.message);
                    else toaster.error(res.statusText);
                }, function(event) {
                    //console.dir(event);
                    scope.loaded = event.loaded; 
                    scope.total = event.total; 
                });
                /*
                for (var i = 0; i < files.length; i++) {
                    Upload.upload({..., data: {file: files[i]}, ...})...;
                }
                // or send them all together for HTML5 browsers:
                */
            }
        }
    };
}]);
    
//end of IIFE (immediately-invoked function expression)
})();

