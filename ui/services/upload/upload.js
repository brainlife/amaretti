'use strict';
(function() {

//https://github.com/danialfarid/ng-file-upload
var service = angular.module('sca-service-upload', [ 'ngFileUpload' ]);
service.directive('scaStepUpload', ['appconf', 'toaster', 'Upload', function(appconf, toaster, Upload) {
    return {
        restrict: 'E',
        scope: {
            workflow: '=',
        }, 
        templateUrl: 'services/upload/upload.html',
        link: function(scope, element) {
            var step_id = scope.$parent.$index; //how accurate is this?
            scope.step = scope.workflow.steps[step_id];
            var config = scope.step.config; //just shorthand
            scope.files = [];

            scope.upload = function() {
                //console.dir(scope.files); return;
                if (scope.files && scope.files.length) {
                    Upload.upload({
                        //TODO - pick appropriate resource_id
                        url: appconf.api+"/service/upload/files?w="+scope.workflow._id+"&s="+step_id+"&resource_id=56842954354c552207761708", 
                        data: {file: scope.files}
                    }).then(function(res) {
                        console.dir(res);
                        scope.step.products.push(res.data);
                        toaster.success("uploaded successfully");
                    }, function(res) {
                        if(res.data && res.data.message) toaster.error(res.data.message);
                        else toaster.error(res.statusText);
                    }, function(event) {
                        console.dir(event);
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

