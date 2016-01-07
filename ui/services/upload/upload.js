'use strict';
(function() {

//https://github.com/danialfarid/ng-file-upload
var service = angular.module('sca-service-upload', [ 'ngFileUpload' ]);
service.directive('scaStepUpload', 
['appconf', 'serverconf', 'toaster', 'Upload', 
function(appconf, serverconf, toaster, Upload) {
    return {
        restrict: 'E',
        scope: {
            workflow: '=',
        }, 
        templateUrl: 'services/upload/upload.html',
        link: function(scope, element) {
            serverconf.then(function(conf) { scope.service_detail = conf.services['upload']; });
            var step_id = scope.$parent.$index; //how accurate is this?
            scope.step = scope.workflow.steps[step_id];
            var config = scope.step.config; //just shorthand
            scope.files = [];

            //for progress
            scope.loaded = null;
            scope.total = null;

            scope.upload = function() {
                scope.loaded = 0;
                scope.total = 1; //can't be 0 since it's used for denominator
                console.dir(scope.files);

                if (scope.files && scope.files.length) {
                    Upload.upload({
                        //TODO - pick appropriate resource_id
                        url: appconf.api+"/service/upload/files?w="+scope.workflow._id+"&s="+step_id+"&resource_id=56842954354c552207761708", 
                        data: {file: scope.files, task: {name: 'from client'}}
                    }).then(function(res) {
                        //console.dir(res);
                        scope.loaded = null;
                        scope.step.tasks.push(res.data);
                        toaster.success("uploaded successfully");
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
        }
    };
}]);
    
//end of IIFE (immediately-invoked function expression)
})();

