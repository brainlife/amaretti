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
            workflow: '=',
            //editing: '=', //optional
        },
        templateUrl: 't/services/comment.html',
        link: function(scope, element) {
            scope.step = scope.workflow.steps[scope.$parent.$index];
            scope.submit = function() {
                delete scope.step.config.editing;
                scope.$parent.save_workflow();
            }
        }
    };
});

app.directive('scaStepHpss', function(appconf, $http, toaster, resources) {
    return {
        restrict: 'E',
        scope: {
            workflow: '=',
        }, 
        templateUrl: 't/services/hpss.html',
        link: function(scope, element) {
            scope.step = scope.workflow.steps[scope.$parent.$index];
            var config = scope.step.config; //just shorthand
            
            //find any sda and hpss supported computing resource (TODO - let user choose if there are more than 1)
            scope.hpss_resources = [];
            scope.compute_resources = []; 
            resources.getall().then(function(myresources) {
                myresources.forEach(function(r) {
                    if(r.type == "hpss") scope.hpss_resources.push(r);
                    if(~r.detail.supports.indexOf("hpss")) scope.compute_resources.push(r);
                });

                if(scope.hpss_resources.length == 0) toaster.error("You do not have HPSS resource defined");
                if(scope.compute_resources.length == 0) toaster.error("You do not have any computing resource capable of accessing hpss");
                select_hpss();
                
                //pick the first compute resource (TODO - pick the most appropriate one instead)
                config.compute_resource_id = scope.compute_resources[0];
            });

            function load(directory) {
                directory.loading = $http.get(appconf.api+'/service/hpss', {params: {
                    resource_id: config.hpss_resource_id,
                    path: directory.path
                }}).then(function(res) {
                    directory.loading = false;
                    directory.children = res.data;
                    postload_process(directory);
                    var contain_path = false;
                    config.paths.forEach(function(path) {
                        if(~path.indexOf(directory.path)) contain_path = true;
                    });
                    if(contain_path || directory == scope.root) toggle(directory);
                }, function(res) {
                    directory.loading = false;
                    if(res.data && res.data.message) toaster.error(res.data.message);
                    else toaster.error(res.statusText);
                });

                return directory.loading;
            }

            //set some extra attributes for each items, and auto-open directory if it contains a selected path
            function postload_process(directory) {
                directory.children.forEach(function(child) {
                    child.depth = directory.depth+1;
                    if(child.entry) child.path = directory.path+"/"+child.entry;
                    if(~config.paths.indexOf(child.path)) child.selected = true;
                });
            }

            function select_hpss() {
                var hpss_resource = null;
                scope.hpss_resources.forEach(function(r) {
                    if(r._id == config.hpss_resource_id) hpss_resource = r;
                });
                if(hpss_resource) {
                    var username = hpss_resource.config.username;
                    var path = "/hpss/"+username.substr(0,1)+"/"+username.substr(1,1)+"/"+username; //TODO - is this hpss universal?
                    scope.root = {depth: 0, open: false, entry: path, /*mode: "000",*/  directory: true, path: path, children: null};
                    scope.item = scope.root; //alias for directory template
                    load(scope.root);
                }
            }
            scope.select_hpss = function() {
                select_hpss();
                config.paths = []; //clear path
                scope.$parent.save_workflow();
            }

            function toggle(directory) {
                directory.open = !directory.open;
                //if(directory.open && !directory.children) load(directory);
                //ensure all grandchildren are loaded
                if(directory.loading) directory.loading.then(ensure_children_loaded);
                else ensure_children_loaded();
                function ensure_children_loaded() {
                    if(!directory.children) return;
                    directory.children.forEach(function(child) {
                        if(child.directory && !child.children) {
                            load(child);
                        } 
                    });
                }
            }
            scope.toggle = toggle;

            scope.select = function(item) {
                item.selected = !item.selected; //for UI ease
                var pos = config.paths.indexOf(item.path);
                if(item.selected) {
                    if(!~pos) config.paths.push(item.path);
                } else {
                    if(~pos) config.paths.splice(pos, 1);
                }
                scope.$parent.save_workflow();
            }

            scope.next = function(directory, offset) {
                directory.next_loading = $http.get(appconf.api+'/service/hpss', {params: {
                    resource_id: config.hpss_resource_id,
                    path: directory.path,
                    offset: offset,
                }}).then(function(res) {
                    directory.children.pop(); //remove the last child which is "next" item
                    directory.next_loading = false;
                    res.data.forEach(function(child) {
                        directory.children.push(child);
                    });
                    postload_process(directory);
                }, function(res) {
                    directory.next_loading = false;
                    if(res.data && res.data.message) toaster.error(res.data.message);
                    else toaster.error(res.statusText);
                });
            }

            //TODO - maybe I should move this to workflow controller?
            scope.submit = function() {
                $http.post(appconf.api+'/task', {
                    step_id: scope.$parent.$index, //step idx
                    workflow_id: scope.workflow._id,
                    service_id: scope.step.service_id,
                    name: 'untitled '+scope.step.service_id+' task '+scope.step.tasks.length,
                    resources: {
                        hpss: config.hpss_resource_id,
                        compute: config.compute_resource_id,
                    },
                    config: {
                        paths: config.paths,
                    },
                }).then(function(res) {
                    scope.step.tasks.push(res.data.task);
                }, function(res) {
                    if(res.data && res.data.message) toaster.error(res.data.message);
                    else toaster.error(res.statusText);
                });
            }
        }
    };
});

app.directive('scaProductRaw', 
["appconf", "$http", "toaster",  
function(appconf, $http, toaster) {
    return {
        restrict: 'E',
        scope: {
            task: '=',
            product: '=',
        },
        templateUrl: 't/products/raw.html',
        link: function(scope, element) {
            scope.appconf = appconf;
            scope.jwt = localStorage.getItem(appconf.jwt_id);
            scope.product_id = scope.$parent.$index;
        }
    }
}]);

app.directive('scaTask', 
["appconf", "$http", "$timeout", "toaster", 
function(appconf, $http, $timeout, toaster) {
    return {
        restrict: 'E',
        scope: {
            task: '=',
        },
        templateUrl: 't/task.html',
        link: function(scope, element) {
            scope.appconf = appconf;
            scope.progress = {progress: 0}; //prevent flickering

            function load_progress() {
                $http.get(appconf.progress_api+"/status/"+scope.task.progress_key)
                .then(function(res) {
                    //TODO - I need to reload task when status *becomes* finished, but I am not sure if this is good enough..
                    if(scope.progress.status == "running" && res.data.status == "finished") {
                        load_task();
                    }
                    scope.progress = res.data;

                    //reload progress - with frequency based on how recent the last update was (0.1 to 60 seconds)
                    var age = Date.now() - scope.progress.update_time;
                    //console.dir(age);
                    var timeout = Math.min(Math.max(age/2, 100), 60*1000);
                    $timeout(load_progress, timeout);
                }, function(res) {
                    if(res.data && res.data.message) toaster.error(res.data.message);
                    else toaster.error(res.statusText);
                });
            }

            function load_task() {
                $http.get(appconf.api+"/task/"+scope.task._id)
                .then(function(res) {
                    scope.task = res.data;
                    toaster.success("Task "+scope.task.name+" completed successfully");
                }, function(res) {
                    if(res.data && res.data.message) toaster.error(res.data.message);
                    else toaster.error(res.statusText);
                });
            }
            
            load_progress();

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
        }
    };
}]);


