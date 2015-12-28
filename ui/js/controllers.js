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

        modalInstance.result.then(function(stepid) {
            
            //load default config
            var step;
            for(var category in $scope.serverconf.steps) {
                $scope.serverconf.steps[category].forEach(function(_step) {
                    if(_step.id == stepid) step = _step.default; 
                });
            }
            /*
            switch(stepid) {
            case "comment":
                step = {type: "comment", text: "ahola", editing: true};
                break;
            default:
                toaster.error("unknown stepid:"+stepid);
            }
            */
            step.type = stepid;
            if(idx === undefined) $scope.workflow.steps.push(step);
            else $scope.workflow.steps.splice(idx, 0, step);
            
            $scope.save_workflow();
        }, function () {
            //toaster.success('Modal dismissed at: ' + new Date());
        });
    };
}]);

app.controller('WorkflowStepSelectorController', ['$scope', '$modalInstance', 'items', 'serverconf', 
function($scope, $modalInstance, items, serverconf) {
    serverconf.then(function(_serverconf) {
        $scope.items = _serverconf.steps;
    });
    /*
    $scope.items = {misc: [
        {id: "comment", label: "Comment", icon: "fa-comment"}
    ]};
    */
    $scope.item_selected = null;
    $scope.select = function(item) {
        $scope.item_selected = item;
    }
    $scope.ok = function () {
        $modalInstance.close($scope.item_selected.id);
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
        resources.getMine().then(function(resources) {
            $scope.myresources = resources;
            /*
            for(var resource_id in $scope.serverconf.resources) {
                if($scope.myresources[resource_id] === undefined) $scope.myresource[resource_id] = {};
            }
            */

            //use default if user hasn't configured for a resource
            for(var rid in _c.resources) {
                var r = _c.resources[rid];
                if(r.default && $scope.myresources[rid] === undefined) {
                    $scope.myresources[rid] = r.default;
                }
            }
        });
    });

    $scope.submit = function(id, resource) {
        resources.upsert(id, resource).then(function(res) {
            toaster.success("successfully updated the resource configuration");
        }, function(res) {     
            toaster.error(res.statusText);
        });
    }
}]);

