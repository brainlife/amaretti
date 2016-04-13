//configure route
app.config(['$routeProvider', 'appconf', function($routeProvider, appconf) {
    $routeProvider.
    when('/about', {
        templateUrl: 't/about.html',
        controller: 'AboutController'
    })

    //list of all available workflows (that user can start)
    .when('/workflows', {
        templateUrl: 't/workflows.html',
        controller: 'WorkflowsController'
    })

    //detail for each workflow (not instance - /sca/inst uses separate page)
    .when('/workflow/:id', {
        templateUrl: 't/workflow.html',
        controller: 'WorkflowController'
    })
    
    //list of all currently running workflows
    .when('/insts', {
        templateUrl: 't/insts.html',
        controller: 'InstsController'
    })

    //allows user to edit list of resources that user has access to
    .when('/resources', {
        templateUrl: 't/resources.html',
        controller: 'ResourcesController'
    })
    .otherwise({
        redirectTo: '/about'
    });
    //console.dir($routeProvider);
}]).run(['$rootScope', '$location', 'toaster', 'jwtHelper', 'appconf', '$http', 'scaMessage',
function($rootScope, $location, toaster, jwtHelper, appconf, $http, scaMessage) {
    $rootScope.$on("$routeChangeStart", function(event, next, current) {
        //redirect to /login if user hasn't authenticated yet
        if(next.requiresLogin) {
            var jwt = localStorage.getItem(appconf.jwt_id);
            if(jwt == null || jwtHelper.isTokenExpired(jwt)) {
                scaMessage.info("Please login first");
                sessionStorage.setItem('auth_redirect', window.location.toString());
                window.location = appconf.auth_url;
                event.preventDefault();
            }
        }
    });

    //check to see if jwt is valid
    var jwt = localStorage.getItem(appconf.jwt_id);
    if(jwt) {
        var expdate = jwtHelper.getTokenExpirationDate(jwt);
        var ttl = expdate - Date.now();
        if(ttl < 0) {
            toaster.error("Your login session has expired. Please re-sign in");
            localStorage.removeItem(appconf.jwt_id);
        } else {
            //TODO - do this via interval?
            if(ttl < 3600*1000) {
                //jwt expring in less than an hour! refresh!
                console.log("jwt expiring in an hour.. refreshing first");
                $http.post(appconf.auth_api+'/refresh')
                    //skipAuthorization: true,  //prevent infinite recursion
                    //headers: {'Authorization': 'Bearer '+jwt},
                .then(function(response) {
                    var jwt = response.data.jwt;
                    localStorage.setItem(appconf.jwt_id, jwt);
                    //menu.user = jwtHelper.decodeToken(jwt);
                });
            }
        }
    }
}]);

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

app.directive('scaTask', 
["appconf", "$http", "$timeout", "toaster", 
function(appconf, $http, $timeout, toaster) {
    return {
        restrict: 'E',
        scope: {
            step: '=',
            task: '=',
        },
        templateUrl: 't/task.html',
        link: function(scope, element) {
            scope.appconf = appconf;
            //scope.progress = {progress: 0}; //prevent flickering

            function load_progress() {
                $http.get(appconf.progress_api+"/status/"+scope.task.progress_key)
                .then(function(res) {
                    /*
                    if(!res.data) {
                        console.log("failed to load progress.. retrying a bitt later");
                        $timeout(load_progress, 2000);
                        return;
                    }
                    */

                    //load products if status becomes running to finished
                    if(scope.progress && scope.progress.status == "running" && res.data.status == "finished") {
                        toaster.success("Task "+scope.task.name+" completed successfully"); //can I assume it's successful?
                        //reload_task().then(reload_products);
                        reload_task();
                    }
                    scope.progress = res.data;

                    //reload progress - with frequency based on how recent the last update was (500msec to 30 seconds)
                    var age = Date.now() - scope.progress.update_time;
                    var timeout = Math.min(Math.max(age/2, 500), 30*1000);
                    if(scope.progress.status != "finished") $timeout(load_progress, timeout);
                }, function(res) {
                    if(res.data && res.data.message) toaster.error(res.data.message);
                    else toaster.error(res.statusText);
                });
            }

            function reload_task() {
                return $http.get(appconf.api+"/task/"+scope.task._id)
                .then(function(res) {
                    //update without chainging parent reference so that change will be visible via workflow
                    for(var k in res.data) {
                        scope.task[k] = res.data[k];
                    } 
                }, function(res) {
                    if(res.data && res.data.message) toaster.error(res.data.message);
                    else toaster.error(res.statusText);
                });
            }

            if(scope.task.progress_key) load_progress();

            //duplicate from progress/ui/js/controller.js#DetailController
            scope.progressType = function(status) {
                switch(status) {
                case "running":
                    return "";
                case "finished":
                    return "success";
                case "canceled":
                case "paused":
                    return "warning";
                case "failed":
                    return "danger";
                default:
                    return "info";
                }
            }

            scope.remove = function() {
                alert('todo..');
            }
            scope.rerun = function() {
                return $http.put(appconf.api+"/task/rerun/"+scope.task._id)
                .then(function(res) {
                    toaster.success(res.data.message);
                    //update without chainging parent reference so that change will be visible via workflow
                    //console.dir(res.data);
                    for(var k in res.data.task) {
                        scope.task[k] = res.data.task[k];
                    } 
                    load_progress();
                }, function(res) {
                    if(res.data && res.data.message) toaster.error(res.data.message);
                    else toaster.error(res.statusText);
                });
            }
        }
    };
}]);

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
    /*
    workflows.get().then(function(workflows) {
        $scope.workflow = workflows[$routeParams.id];;
    });
    */
    
    //load available workflows (TODO - add querying capability)
    $http.get(appconf.api+'/workflow/'+$routeParams.id)
    .then(function(res) {
        $scope.workflow = res.data;
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
    };
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

