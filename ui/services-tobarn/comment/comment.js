'use strict';
(function() {

var service = angular.module('sca-service-comment', []);

service.directive('scaStepComment', [ function() {
    return {
        restrict: 'E',
        scope: {
            workflow: '=',
            //editing: '=', //optional
        },
        templateUrl: 'services/comment/comment.html',
        link: function(scope, element) {
            scope.step = scope.workflow.steps[scope.$parent.$index];
            scope.submit = function() {
                delete scope.step.config.editing;
                scope.$parent.save_workflow();
            }
        }
    };
}]);

//end of IIFE (immediately-invoked function expression)
})();

