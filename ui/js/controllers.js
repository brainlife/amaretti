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
    $scope.user = menu.user; 
    $scope.i_am_header = true;
}]);

//list all available workflows and instances
app.controller('WorkflowsController', ['$scope', 'menu', 'scaMessage', 'toaster', 'jwtHelper', '$location', '$http', 'appconf',
function($scope, menu, scaMessage, toaster, jwtHelper, $location, $http, appconf) {
    scaMessage.show(toaster);

    $http.get(appconf.api+'/instance')
    .then(function(res) {
        $scope.instances = res.data.instances;
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
    
    //load running tasks
    $http.get(appconf.api+'/task', {params: {
        where: {status: "running"}, 
    }})
    .then(function(res) {
        $scope.running_tasks = {};
        //organize running tasks into each workflows
        res.data.forEach(function(task) {
            if(!$scope.running_tasks[task.instance_id]) $scope.running_tasks[task.instance_id] = [];
            $scope.running_tasks[task.instance_id].push(task); 
        });
        //console.dir($scope.running_tasks);
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
        //$location.path("/workflow/"+wid);
        var wf = $scope.workflows[wid];
        document.location = wf.url;
    }
    $scope.openinst = function(inst) {
        //window.open causes window block
        //window.open($scope.workflows[inst.workflow_id].url+"#/start/"+inst._id, 'scainst:'+inst._id);
        if($scope.workflows[inst.workflow_id] == undefined) {
            toaster.pop('error', "Can't find Workflow UI with workflow_id:"+inst.workflow_id);
        } else {
            document.location = $scope.workflows[inst.workflow_id].url+"#/start/"+inst._id;//, 'scainst:'+inst._id);
        }
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
        return $http.post(appconf.api+'/instance', {
            workflow_id: $routeParams.id,
            name: $scope.form.name,
            desc: $scope.form.desc,
        }).then(function(res) {
            var instance = res.data;
            //scaMessage.success("Created a new workflow instance"); //TODO unnecessary?
            //window.open($scope.workflow.url+"#/start/"+instance._id, 'scainst:'+instance._id);
            document.location = $scope.workflow.url+"#/start/"+instance._id;
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
        document.location = $scope.workflow.url+"#/start/"+inst._id;
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
}]);

//TODO will be moved to inst.js ... has this already happened?
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
                        service_detail: $scope.serverconf.services[task.service],
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
                service: service.id,
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

app.controller('ResourcesController', ['$scope', 'menu', 'serverconf', 'scaMessage', 'toaster', 'jwtHelper', '$routeParams', '$http', 'resources', 'scaSettingsMenu', '$uibModal', 
function($scope, menu, serverconf, scaMessage, toaster, jwtHelper, $routeParams, $http, resources, scaSettingsMenu, $uibModal) {
    scaMessage.show(toaster);
    $scope.settings_menu = scaSettingsMenu;

    serverconf.then(function(_c) { 
        $scope.serverconf = _c; 

        resources.getall().then(function(resources) {
            $scope.myresources = resources;
        });

    });

    function prepare_submission(inst) {
        //convert gids to list of ids instead of groups
        var gids = [];
        inst.gids.forEach(function(group) { gids.push(group.id); });
        inst.gids = gids;

        //convert _envs to key/value in object
        inst.envs = {};
        if(inst._envs) {
            inst._envs.split("\n").forEach(function(env) {
                var pos = env.indexOf("=");
                var key = env.substr(0, pos);
                if(!key) return;//skip empty keys
                var value = env.substr(pos+1);
                inst.envs[key] = value;
            });
        }
        //console.dir(inst);
        //debugger;
    }

    $scope.addnew = function(resource) {
        var modalInstance = create_dialog(resource);
        modalInstance.result.then(function(_inst) {
            prepare_submission(_inst);
            $http.post($scope.appconf.api+'/resource/', _inst)
            .then(function(res) {
                toaster.success("Created resource");
                console.dir(res.data);
                $scope.myresources.push(res.data);
            }, function(res) {
                if(res.data && res.data.message) toaster.error(res.data.message);
                else toaster.error(res.statusText);
            });
        }, function (action) {
            console.log(action);
            //anything to do when user dismiss?
        });
    }

    $scope.edit = function(resource, inst) {
        var modalInstance = create_dialog(resource, inst);
        modalInstance.result.then(function(_inst) {
            prepare_submission(_inst);
            $http.put($scope.appconf.api+'/resource/'+_inst._id, _inst)
            .then(function(res) {
                toaster.success("Updated resource");
            }, function(res) {
                if(res.data && res.data.message) toaster.error(res.data.message);
                else toaster.error(res.statusText);
            });
            //update original
            for(var k in inst) inst[k] = _inst[k];
        }, function (action) {
            switch(action) {
            case "remove":
                $scope.remove(inst);
            }
            
        });
    }

    $scope.remove = function(inst) {
        console.log("removing");
        $http.delete($scope.appconf.api+'/resource/'+inst._id)
        .then(function(res) {
            toaster.success("Resource removed");
            
            //remove the resource from myresources
            var pos = $scope.myresources.indexOf(inst);
            $scope.myresources.splice(pos, 1);
        }, function(res) {
            if(res.data && res.data.message) toaster.error(res.data.message);
            else toaster.error(res.statusText);
        });
    }

    $scope.test = function(resource, inst, $event) {
        $event.stopPropagation();
        $http.put($scope.appconf.api+'/resource/test/'+inst._id)
        .then(function(res) {
            if(res.data.status == "ok") {
                toaster.success("Resource configured properly!");
            } else {
                toaster.error(res.data.message);
            }
        }, function(res) {
            if(res.data && res.data.message) toaster.error(res.data.message);
            else toaster.error(res.statusText);
        });
    }

    $scope.autoconf = function() {
        //alert('todo.. please configure your resources manually for now');
        document.location = "#/autoconf";
    }

    function create_dialog(resource, inst) {
        var template = null;

        //TODO default username to SCA username?
        var def = {active: true, config: {}, type: resource.type, resource_id: resource._rid, gids: [], envs: []};
        switch(resource.type) {
        case "hpss":
            template = "resources.hpss.html"; 
            def.config.auth_method = 'keytab';
            break;
        default:
            template = "resources.ssh.html";
        }

        return $uibModal.open({
            templateUrl: template,
            controller: function($scope, inst, resource, $uibModalInstance, $http, appconf) {
                if(inst) {
                    //update
                    $scope.inst = angular.copy(inst);
                } else {
                    //new
                    $scope.inst = def;

                    console.log("generating key");
                    $http.get(appconf.api+'/resource/gensshkey/')
                    .then(function(res) {
                        $scope.inst.config.ssh_public = res.data.pubkey;
                        $scope.inst.config.enc_ssh_private = res.data.key;
                    }, function(res) {
                        if(res.data && res.data.message) toaster.error(res.data.message);
                        else toaster.error(res.statusText);
                    });
                }
        
                //stringify inst.envs
                $scope.inst._envs = "";
                for(var key in $scope.inst.envs) {
                    $scope.inst._envs += key+"="+$scope.inst.envs[key]+"\n";
                }

                $scope.resource = resource;
                $scope.cancel = function() {
                    $uibModalInstance.dismiss('cancel');
                }
                $scope.remove = function() {
                    $uibModalInstance.dismiss('remove');
                }
                $scope.ok = function() {
                    $uibModalInstance.close($scope.inst);
                }
            },
            backdrop: 'static',
            resolve: {
                inst: function () { return inst; },
                resource: function () { return resource; }
            }
        });
    }
}]);

app.controller('ServicesController', ['$scope', 'menu', 'serverconf', 'scaMessage', 'toaster', 'jwtHelper', '$location', 'services',
function($scope, menu, serverconf, scaMessage, toaster, jwtHelper, $location, services) {
    scaMessage.show(toaster);
    console.dir($scope.user);
    services.query({}).then(function(ss) {
        $scope.services = ss.services;
        $scope.service_count = ss.count;
    });
}]);

app.component('serviceDetail', {
    templateUrl: 't/service-detail.html',
    bindings: {
        service: '<'
    },
    controller: function() {
    },
});

app.component('accessGroups', {
    templateUrl: 't/groups.html',
    bindings: {
        gids: '='
    },
    controller: function(groups) {
        var ctrl = this;
        //and we need to load groups
        groups.then(function(_groups) {
            ctrl.groups = _groups;

            //convert list of gids to groups
            var selected = [];
            _groups.forEach(function(group) {
                if(~ctrl.gids.indexOf(group.id)) selected.push(group);
            });
            ctrl.gids = selected;
        });
    },
});

app.controller('AutoconfController', ['$scope', 'menu', 'serverconf', 'scaMessage', 'toaster', 'jwtHelper', '$location', 'services', 'resources', 'appconf', '$http',
function($scope, menu, serverconf, scaMessage, toaster, jwtHelper, $location, services, resources, appconf, $http) {
    scaMessage.show(toaster);

    $scope.page = "select";
    var jwt = localStorage.getItem(appconf.jwt_id);
    if(jwt) var user = jwtHelper.decodeToken(jwt);

    $scope.userpass = {};

    serverconf.then(function(_c) { 
        $scope.resource_details = _c.resources;

        for(var id in $scope.resource_details) {
            var detail = $scope.resource_details[id];
            /*
            if(detail.type == "ssh") {
                detail._ssh = true;
            }
            */
            detail._select = true;
        }

        //find resources that user already configured
        resources.getall().then(function(resources) {
            resources.forEach(function(resource) {
                var detail = $scope.resource_details[resource.resource_id];
                if(detail && resource.config && resource.config.username) {
                    //if(resource.config.username == user.profile.username) {
                    detail._configured = resource.config.username;//true;
                    detail._select = false; 
                    //}
                }
            });
        });
    });

    $scope.gotopage = function(page) {
        $scope.page = page;
    } 

    function install(keys, resource_id, resource) {
        resource._status = "Installing SSH public key";

        $http.post(appconf.api+'/resource/installsshkey', {
            username: $scope.userpass.username,
            password: $scope.userpass.password,
            host: resource.hostname,
            comment: "Public key for sca resource (autoconf)",
            pubkey: keys.pubkey,
        })
        .then(function(res) {
            resource._status = "Registering resource with SCA";
            //console.dir(resource);
            $http.post(appconf.api+'/resource', {
                type: resource.type,
                resource_id: resource_id,
                name: $scope.userpass.username+"@"+resource.name,
                active: true,
                config: {
                    username: $scope.userpass.username,
                    enc_ssh_private: keys.key,
                    ssh_public: keys.pubkey,
                },
            })
            .then(function(res) {
                resource._status = "Testing resource";
                $http.put(appconf.api+"/resource/test/"+res.data._id)
                .then(function(res) {
                    resource._status = "Resource registered successfully";
                }, function(res) {
                    if(res.data && res.data.message) toaster.error(res.data.message);
                    else toaster.error(res.statusText);
                    resource._status = "Resource registered but test failed";
                });
            }, function(res) {
                if(res.data && res.data.message) toaster.error(res.data.message);
                else toaster.error(res.statusText);
                resource._status = "Failed to register resource entry";
            });
        }, function(res) {
            if(res.data && res.data.message) toaster.error(res.data.message);
            else toaster.error(res.statusText);
            resource._status = "Failed to install SSH public key";
        });
    }

    $scope.run = function() {
        $scope.page = 'run';
        $http.get(appconf.api+'/resource/gensshkey')
        .then(function(res) {
            $scope.keys = res.data;
            //install all resources
            for(var id in $scope.resource_details) {
                var resource_detail = $scope.resource_details[id];
                if(resource_detail._select) {
                    install(res.data, id, resource_detail);
                }
            }
        }, function(res) {
            if(res.data && res.data.message) toaster.error(res.data.message);
            else toaster.error(res.statusText);
        });
    }

    $scope.finish = function() {
        document.location = "#/resources/";
    }
}]);

