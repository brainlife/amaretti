'use strict';
(function() {

var service = angular.module('sca-service-hpss', [ 'app.config', 'toaster' ]);
service.directive('scaStepHpss', 
['appconf', 'serverconf', '$http', 'toaster', 'resources', 
function(appconf, serverconf, $http, toaster, resources) {
    return {
        restrict: 'E',
        scope: {
            workflow: '=',
        }, 
        templateUrl: 'services/hpss/hpss.html',
        link: function(scope, element) {
            serverconf.then(function(conf) { scope.service_detail = conf.services['hpss_import']; });
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
                config.compute_resource_id = scope.compute_resources[0]._id;
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
                    if(contain_path /*|| directory == scope.root*/) toggle(directory);
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
                var name = config.name||'untitled '+scope.step.service_id+' task '+scope.step.tasks.length;
                $http.post(appconf.api+'/task', {
                    step_idx: scope.$parent.$index, //step idx
                    workflow_id: scope.workflow._id,
                    service_id: scope.step.service_id,
                    name: name,
                    resources: {
                        hpss: config.hpss_resource_id,
                        compute: config.compute_resource_id,
                    },
                    config: config,
                    /*
                    config: {
                        paths: config.paths,
                    },
                    */
                }).then(function(res) {
                    scope.step.tasks.push(res.data.task);
                }, function(res) {
                    if(res.data && res.data.message) toaster.error(res.data.message);
                    else toaster.error(res.statusText);
                });
            }
        }
    };
}]);
    
//end of IIFE (immediately-invoked function expression)
})();

