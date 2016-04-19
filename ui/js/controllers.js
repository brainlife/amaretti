'use strict';

app.controller('AboutController', ['$scope', 'appconf', 'menu', 'serverconf', 'scaMessage', 'toaster', 'jwtHelper',
function($scope, appconf, menu, serverconf, scaMessage, toaster, jwtHelper) {
    scaMessage.show(toaster);
    $scope.appconf = appconf;
}]);

//load common stuff that most controller uses
app.controller('PageController', ['$scope', 'appconf', '$route', 'serverconf', 'menu',
function($scope, appconf, $route, serverconf, menu) {
    $scope.appconf = appconf; 
    $scope.title = appconf.title;
    serverconf.then(function(_c) { $scope.serverconf = _c; });
    $scope.menu = menu;
    $scope.user = menu.user; //for app menu
    $scope.i_am_header = true;
}]);

//list all available workflows and instances
app.controller('WorkflowsController', ['$scope', 'menu', 'scaMessage', 'toaster', 'jwtHelper', '$location', '$http', 'appconf',
function($scope, menu, scaMessage, toaster, jwtHelper, $location, $http, appconf) {
    scaMessage.show(toaster);

    $http.get(appconf.api+'/instance')
    .then(function(res) {
        $scope.instances = res.data;
    }, function(res) {
        if(res.data && res.data.message) toaster.error(res.data.message);
        else toaster.error(res.statusText);
    });

    //load available workflows (TODO - add querying capability)
    $http.get(appconf.api+'/workflow')
    .then(function(res) {
        $scope.workflows = res.data;
    }, function(res) {
        if(res.data && res.data.message) toaster.error(res.data.message);
        else toaster.error(res.statusText);
    });

    /*
    workflows.get().then(function(workflows) {
        //console.dir(workflows);
        $scope.workflows = workflows;
    });
    */
    $scope.openwf = function(wid) {
        $location.path("/workflow/"+wid);
    }
    $scope.openinst = function(inst) {
        window.open($scope.workflows[inst.workflow_id].url+"#/start/"+inst._id, 'scainst:'+inst._id);
    }
}]);

//show workflow detail (not instance)
app.controller('WorkflowController', ['$scope', 'appconf', 'menu', 'serverconf', 'scaMessage', 'toaster', 'jwtHelper', '$location', '$routeParams', '$http',
function($scope, appconf, menu, serverconf, scaMessage, toaster, jwtHelper, $location, $routeParams, $http) {
    scaMessage.show(toaster);
    
    $http.get(appconf.api+'/workflow/'+$routeParams.id)
    .then(function(res) {
        $scope.workflow = res.data;

        //load instances under this workflow (for this user)
        $http.get(appconf.api+'/instance', {params: {
            where: {workflow_id: $scope.workflow.name},
        }})
        .then(function(res) {
            $scope.instances = res.data;
            console.dir(res.data);
        }, function(res) {
            if(res.data && res.data.message) toaster.error(res.data.message);
            else toaster.error(res.statusText);
        });
    }, function(res) {
        if(res.data && res.data.message) toaster.error(res.data.message);
        else toaster.error(res.statusText);
    });

    $http.get(appconf.api+'/comment/workflow/'+$routeParams.id)
    .then(function(res) {
        $scope.comments = res.data;
    }, function(res) {
        if(res.data && res.data.message) toaster.error(res.data.message);
        else toaster.error(res.statusText);
    });

    $scope.back = function() {
        $location.path("/workflows");
    }

    $scope.form = {};
    $scope.submit = function() {
        return $http.post(appconf.api+'/instance/'+$routeParams.id, {
            name: $scope.form.name,
            desc: $scope.form.desc,
        }).then(function(res) {
            var instance = res.data;
            //scaMessage.success("Created a new workflow instance"); //TODO unnecessary?
            window.open($scope.workflow.url+"#/start/"+instance._id, 'scainst:'+instance._id);
        }, function(res) {
            if(res.data && res.data.message) toaster.error(res.data.message);
            else toaster.error(res.statusText);
        });
    }

    $scope.addcomment = function() {
        //console.dir($scope.comment);
        $http.post(appconf.api+'/comment/workflow/'+$routeParams.id, {
            text: $scope.comment,
        }).then(function(res) {
            $scope.comments.push(res.data);
        }, function(res) {
            if(res.data && res.data.message) toaster.error(res.data.message);
            else toaster.error(res.statusText);
        });
    }
    $scope.openinst = function(inst) {
        window.open($scope.workflow.url+"#/start/"+inst._id, 'scainst:'+inst._id);
    }
}]);

//show list of all workflow instances that user owns
app.controller('InstsController', ['$scope', 'menu', 'serverconf', 'scaMessage', 'toaster', 'jwtHelper', '$location',
function($scope, menu, serverconf, scaMessage, toaster, jwtHelper, $location) {
    scaMessage.show(toaster);
    
    //load available workflows (TODO - add querying capability)
    $http.get(appconf.api+'/workflow')
    .then(function(res) {
        $scope.workflows = res.data;
    }, function(res) {
        if(res.data && res.data.message) toaster.error(res.data.message);
        else toaster.error(res.statusText);
    });

    /*
    workflows.getInsts().then(function(mine) {
        $scope.workflows = mine;
    });
    */
    /*
    $scope.create = function() {
        workflows.create().then(function(res) {
            var workflow = res.data;
            scaMessage.success("Created a new workflow instance"); //TODO unnecessary?
            document.location("inst/#/"+workflow._id);
        }, function(res) {
            if(res.data && res.data.message) toaster.error(res.data.message);
            else toaster.error(res.statusText);
        });
    };
    */
}]);

//TODO will be moved to inst.js
app.controller('InstController', ['$scope', 'menu', 'serverconf', 'scaMessage', 'toaster', 'jwtHelper', '$routeParams', '$http', '$modal',
function($scope, menu, serverconf, scaMessage, toaster, jwtHelper, $routeParams, $http, $modal) {
    scaMessage.show(toaster);
    serverconf.then(function(_serverconf) { $scope.serverconf = _serverconf; });

    $scope.workflow = {steps: []}; //so that I can start watching workflow immediately
    $scope._products = [];

    $http.get($scope.appconf.api+'/workflow/'+$routeParams.id)
    .then(function(res) {
        $scope.workflow = res.data;
    }, function(res) {
        if(res.data && res.data.message) toaster.error(res.data.message);
        else toaster.error(res.statusText);
    });

    $scope.$watch('workflow', function(nv, ov) {
        $scope._products.length = 0; //clear without changing reference 
        $scope.workflow.steps.forEach(function(step) {
            step.tasks.forEach(function(task) {
                for(var product_idx = 0;product_idx < task.products.length; product_idx++) {
                    var product = task.products[product_idx];                
                    $scope._products.push({
                        product: product,
                        step: step,    
                        task: task, 
                        service_detail: $scope.serverconf.services[task.service_id],
                        product_idx: product_idx
                    });
                }
            });
        });
    }, true);//deepwatch-ing the entire workflow maybe too expensive..

    ///////////////////////////////////////////////////////////////////////////////////////////////
    //functions

    //TODO rename to just save()?
    $scope.save_workflow = function() {
        $http.put($scope.appconf.api+'/workflow/'+$routeParams.id, $scope.workflow)
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
            size: 'lg',
            resolve: {
                //TODO what is this?
                items: function () {
                    return {'item': 'here'}
                }
            }
        });

        modalInstance.result.then(function(service) {
            //instantiate new step
            //var newstep = angular.copy(service.default);
            var newstep = {
                service_id: service.id,
                name: 'untitled',
                config: service.default,
                tasks: [],
            };
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
        $scope.groups = [];
        $scope.services_a = [];
        for(var service_id in  _serverconf.services) {
            var service = _serverconf.services[service_id];
            service.id = service_id;
            $scope.services_a.push(service);
            if(!~$scope.groups.indexOf(service.group)) $scope.groups.push(service.group);
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

app.controller('ResourcesController', ['$scope', 'menu', 'serverconf', 'scaMessage', 'toaster', 'jwtHelper', '$routeParams', '$http', 'resources', 'scaSettingsMenu',
function($scope, menu, serverconf, scaMessage, toaster, jwtHelper, $routeParams, $http, resources, scaSettingsMenu) {
    scaMessage.show(toaster);
    $scope.settings_menu = scaSettingsMenu;

    serverconf.then(function(_c) { 
        $scope.serverconf = _c; 
        resources.getall().then(function(resources) {
            $scope.myresources = resources;
        });
    });

    $scope.submit = function(resource) {
        resources.upsert(resource).then(function(res) {
            toaster.success("successfully updated the resource configuration");
            //update with new content without updating anything else
            for(var k in res.data) { resource[k] = res.data[k]; }
        }, function(res) {     
            if(res.data && res.data.message) toaster.error(res.data.message);
            else toaster.error(res.statusText);
        });
    }

    $scope.newresource_id = null;
    $scope.add = function() {
        resources.add($scope.newresource_id);
    }
    $scope.reset_sshkey = function(resource) {
        $http.post($scope.appconf.api+'/resource/resetsshkeys/'+resource._id)
        .then(function(res) {
            toaster.success("Successfully reset your ssh keys. Please update your public key in ~/.ssh/authorized_keys!");
            resource.config.ssh_public = res.data.ssh_public;
        }, function(res) {
            if(res.data && res.data.message) toaster.error(res.data.message);
            else toaster.error(res.statusText);
        });
    }
}]);

/*
app.controller('TaskController', ['$scope', 'toaster', '$http', 'jwtHelper', 'scaMessage', '$routeParams', '$location', '$timeout', 
function($scope, toaster, $http, jwtHelper, scaMessage, $routeParams, $location, $timeout) {
    scaMessage.show(toaster);
    $scope.taskid = $routeParams.taskid; 
    $scope.path = $routeParams.instid+"/"+$scope.taskid; //path to open by default

    //for file service to show files to download
    $scope.jwt = localStorage.getItem($scope.appconf.jwt_id);

    load();

    var tm = null;
    function load() {
        $http.get($scope.appconf.api+"/task/"+$scope.taskid)
        .then(function(res) {
            $scope.task = res.data;
            $scope.resource_id = $scope.task.resource_id;

            //load new task status unless it's finished/failed
            if($scope.task.status != "finished" && $scope.task.status != "failed" && $scope.task.status != "stopped") {
                tm = $timeout(load, 3*1000); //reload in 3 seconds
            }

            //load progress info
            $http.get($scope.appconf.progress_api+"/status/"+$scope.task.progress_key, {params: { depth: 2, }})
            .then(function(res) {
                $scope.progress = res.data;
            }, function(res) {
                if(res.data && res.data.message) toaster.error(res.data.message);
                else toaster.error(res.statusText);
            });

        }, function(res) {
            if(res.data && res.data.message) toaster.error(res.data.message);
            else toaster.error(res.statusText);
        });
    }
    //setup task refresher
    $scope.$on("$locationChangeSuccess", function() {
        if(tm) $timeout.cancel(tm);
    });

    $scope.back = function(page) {
        $location.path("/"+page+"/"+$routeParams.instid);
    }

    $scope.stop = function() {
        $http.put($scope.appconf.api+"/task/stop/"+$scope.task._id)
        .then(function(res) {
            toaster.success("Requested to stop this task");
        }, function(res) {
            if(res.data && res.data.message) toaster.error(res.data.message);
            else toaster.error(res.statusText);
        });
    }

    $scope.rerun = function() {
        $http.put($scope.appconf.api+"/task/rerun/"+$scope.task._id)
        .then(function(res) {
            toaster.success("Requested to rerun this task");
            load();
        }, function(res) {
            if(res.data && res.data.message) toaster.error(res.data.message);
            else toaster.error(res.statusText);
        });
    }

}]);
*/
