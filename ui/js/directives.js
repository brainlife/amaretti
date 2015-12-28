'use strict';

app.directive('scaWorkflowInfo', function() {
    return {
        restrict: 'E',
        templateUrl: 't/workflow.info.html',
        link: function(scope, element) {
            scope.submit = function() {
                delete scope.workflow.editing;
                scope.save_workflow();
            }
        }
    };
});

app.directive('scaStepComment', function() {
    return {
        restrict: 'E',
        scope: {
            step: '=',
            //editing: '=', //optional
        },
        templateUrl: 't/steps/comment.html',
        link: function(scope, element) {
            scope.submit = function() {
                delete scope.step.editing;
                scope.$parent.save_workflow();
            }
        }
    };
});

app.directive('scaStepHpss', function(appconf, $http, toaster) {
    return {
        restrict: 'E',
        scope: {
            step: '=',
        },
        templateUrl: 't/steps/hpss.html',
        link: function(scope, element) {
            var resource_id = "56803b387832d36fa879ecdb";
            scope.load = function() {
                $http.get(appconf.api+'/hpss', {params: { resource_id: resource_id}})
                .then(function(res) {
                    scope.root = {open: false, path: '/', children: res.data};
                }, function(res) {
                    if(res.data && res.data.message) toaster.error(res.data.message);
                    else toaster.error(res.statusText);
                });
            }
            scope.load();
            /*
            scope.submit = function() {
                delete scope.step.editing;
                scope.$parent.save_workflow();
            }
            */
        }
    };
});

app.directive('scaStepHpssDirectory', function(appconf, $http, toaster) {
    return {
        restrict: 'E',
        scope: {
            directory: '=',
        },
        templateUrl: 't/steps/hpss.directory.html',
        link: function(scope, element) {
            console.dir(scope);
            scope.toggle = function() {
                scope.directory.open = !scope.directory.open;
                //ensure all grandchildren are loaded
                scope.directory.children.forEach(function(child) {
                    if(child.mode.directory) {
                        console.log("need to load:"+child.entry);
                    } 
                });
            }
        }
    };
});

