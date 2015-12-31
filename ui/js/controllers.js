'use strict';

app.controller('AboutController', ['$scope', 'appconf', 'menu', 'serverconf', 'scaMessage', 'toaster', 'jwtHelper',
function($scope, appconf, menu, serverconf, scaMessage, toaster, jwtHelper) {
    scaMessage.show(toaster);
    $scope.appconf = appconf;
}]);

app.controller('HeaderController', ['$scope', 'appconf', '$route', 'serverconf', 'menu',
function($scope, appconf, $route, serverconf, menu) {
    $scope.title = appconf.title;
    serverconf.then(function(_c) { $scope.serverconf = _c; });
    $scope.menu = menu;
    $scope.user = menu.user; //for app menu
}]);

app.controller('WorkflowsController', ['$scope', 'appconf', 'menu', 'serverconf', 'scaMessage', 'toaster', 'jwtHelper', 'workflows', '$location',
function($scope, appconf, menu, serverconf, scaMessage, toaster, jwtHelper, workflows, $location) {
    scaMessage.show(toaster);
    $scope.appconf = appconf;
    workflows.getMine().then(function(mine) {
        $scope.workflows = mine;
    });
    $scope.create = function() {
        workflows.create().then(function(res) {
            var workflow = res.data;
            $location.path("/workflow/"+workflow._id);
            toaster.success("Created a new workflow");
        }, function(res) {
            if(res.data && res.data.message) toaster.error(res.data.message);
            else toaster.error(res.statusText);
        });
    };
}]);

app.controller('WorkflowController', ['$scope', 'appconf', 'menu', 'serverconf', 'scaMessage', 'toaster', 'jwtHelper', '$routeParams', '$http', '$modal',
function($scope, appconf, menu, serverconf, scaMessage, toaster, jwtHelper, $routeParams, $http, $modal) {
    scaMessage.show(toaster);
    $scope.appconf = appconf;
    serverconf.then(function(_serverconf) { $scope.serverconf = _serverconf; });

    $http.get(appconf.api+'/workflow/'+$routeParams.id)
    .then(function(res) {
        $scope.workflow = res.data;
        /*
        $scope.$watch('workflow', function(nv, ol) {
            console.log("workflow got updated - auto save?");
        }, true); //object
        */
    }, function(res) {
        if(res.data && res.data.message) toaster.error(res.data.message);
        else toaster.error(res.statusText);
    });

    /*
    //for editing workflow attributes (name, desc)
    $scope.edit = {};
    $scope.start_edit = function(id) {
        $scope.edit[id] = $scope.workflow[id];
    }
    $scope.end_edit = function(id) {
        //TODO
        alert($scope.edit[id]);
        $scope.edit[id] = null;
    }
    */

    $scope.save_workflow = function() {
        $http.put(appconf.api+'/workflow/'+$routeParams.id, $scope.workflow)
        .then(function(res) {
            console.log("workflow updated");
        }, function(res) {
            if(res.data && res.data.message) toaster.error(res.data.message);
            else toaster.error(res.statusText);
        });
    }

    $scope.removestep = function(idx) {
        $scope.workflow.steps.splice(idx, 1);
        $scope.save_workflow();
    }

    $scope.addstep = function(idx) {
        var modalInstance = $modal.open({
            //animation: $scope.animationsEnabled,
            templateUrl: 't/workflow.step_selector.html',
            controller: 'WorkflowStepSelectorController',
            //size: size,
            resolve: {
                items: function () {
                    return {'item': 'here'}
                }
            }
        });

        modalInstance.result.then(function(service) {
            //instantiate new step
            var newstep = angular.copy(service.default);
            newstep.service_id = service.id;

            //finally, add the step and update workflow
            if(idx === undefined) $scope.workflow.steps.push(newstep);
            else $scope.workflow.steps.splice(idx, 0, newstep);
            $scope.save_workflow();
        }, function () {
            //toaster.success('Modal dismissed at: ' + new Date());
        });
    };
}]);

app.controller('WorkflowStepSelectorController', ['$scope', '$modalInstance', 'items', 'serverconf', 
function($scope, $modalInstance, items, serverconf) {
    serverconf.then(function(_serverconf) {
        $scope.services_a = [];
        for(var service_id in  _serverconf.services) {
            var service = _serverconf.services[service_id];
            service.id = service_id;
            $scope.services_a.push(service);
        }
    });
    $scope.service_selected = null;
    $scope.select = function(service) {
        $scope.service_selected = service;
    }
    $scope.ok = function () {
        $modalInstance.close($scope.service_selected);
    };
    $scope.cancel = function () {
        $modalInstance.dismiss('cancel');
    };
}]);

app.controller('ResourcesController', ['$scope', 'appconf', 'menu', 'serverconf', 'scaMessage', 'toaster', 'jwtHelper', '$routeParams', '$http', 'resources', 
function($scope, appconf, menu, serverconf, scaMessage, toaster, jwtHelper, $routeParams, $http, resources) {
    scaMessage.show(toaster);
    $scope.appconf = appconf;

    serverconf.then(function(_c) { 
        $scope.serverconf = _c; 
        resources.getall().then(function(resources) {
            $scope.myresources = resources;
        });
    });

    $scope.submit = function(resource) {
        resources.upsert(resource).then(function(res) {
            toaster.success("successfully updated the resource configuration");
        }, function(res) {     
            toaster.error(res.statusText);
        });
    }

    $scope.newresource = null;
    $scope.add = function() {
        resources.add($scope.newresource);
    }
}]);

