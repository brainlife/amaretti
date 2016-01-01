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

app.directive('scaStepHpss', function(appconf, $http, toaster, resources) {
    return {
        restrict: 'E',
        scope: {
            workflow: '=',
            step: '=',
        },
        templateUrl: 't/steps/hpss.html',
        link: function(scope, element) {
            function load(directory) {
                $http.get(appconf.api+'/hpss', {params: {
                    resource_id: scope.hpss_resource._id,
                    path: directory.path}
                }).then(function(res) {
                    directory.children = res.data;
                    directory.children.forEach(function(child) {
                        child.depth = directory.depth+1;
                        child.path = directory.path+"/"+child.entry;
                        if(~scope.step.paths.indexOf(child.path)) child.selected = true;
                    });
                }, function(res) {
                    if(res.data && res.data.message) toaster.error(res.data.message);
                    else toaster.error(res.statusText);
                });
            }

            //find any sda and hpss supported computing resource (TODO - let user choose if there are more than 1)
            scope.hpss_resource = null;
            scope.compute_resource = null; 
            resources.getall().then(function(myresources) {
                myresources.forEach(function(r) {
                    if(r.type == "hpss") scope.hpss_resource = r;  
                    if(~r.detail.supports.indexOf("hpss")) scope.compute_resource = r;
                });

                if(scope.hpss_resource == null) toaster.error("You do not have HPSS resource defined");
                if(scope.compute_resource == null) toaster.error("You do not have any computing resource capable of accessing hpss");

                var username = scope.hpss_resource.config.username;
                var path = "/hpss/"+username.substr(0,1)+"/"+username.substr(1,1)+"/"+username; //TODO - is this hpss universal?
                scope.root = {depth: 0, open: false, entry: path, mode: {directory: true}, path: path, children: null};
                scope.item = scope.root; //alias for directory template
                load(scope.root);
            });         

            scope.toggle = function(directory) {
                directory.open = !directory.open;
                //ensure all grandchildren are loaded
                directory.children.forEach(function(child) {
                    if(child.mode.directory && !child.children) {
                        load(child);
                    } 
                });
            }

            scope.select = function(item) {
                item.selected = !item.selected; //for UI ease
                var pos = scope.step.paths.indexOf(item.path);
                if(item.selected) {
                    if(!~pos) scope.step.paths.push(item.path);
                } else {
                    if(~pos) scope.step.paths.splice(pos, 1);
                }
                scope.$parent.save_workflow();
            }

            /*
            //find paths selected
            function findselected(item, paths) {
                if(item.selected) paths.push(item.path);
                if(item.children) item.children.forEach(function(child) {
                    findselected(child, paths);
                });
            } 
            */

            scope.submit = function() {
                //var paths = [];
                //findselected(scope.root, paths);
                $http.post(appconf.api+'/task/request', {
                    workflow_id: scope.workflow._id,
                    service_id: scope.step.service_id,
                    config: {
                        resource_ids: {
                            hpss: scope.hpss_resource._id,
                            compute: scope.compute_resource._id,
                        },
                        paths: scope.step.paths,
                    },
                }).then(function(res) {
                    //scope.step.tasks.push(res.data.task);
                    scope.step.tasks.push(res.data.task);
                    scope.$parent.save_workflow(); //TODO - let server side do this update (it's silly that client has to re-send data..)
                }, function(res) {
                    if(res.data && res.data.message) toaster.error(res.data.message);
                    else toaster.error(res.statusText);
                });
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
            task: '=',
        },
        templateUrl: 't/task.html',
        link: function(scope, element) {
            scope.appconf = appconf;
    
            function load_progress() {
                $http.get(appconf.progress_api+"/status/"+scope.task.progress_key)
                .then(function(res) {
                    scope.progress = res.data;

                    //reload progress - with frequency based on how recent the last update was (0.1 to 60 seconds)
                    var age = Date.now() - scope.progress.update_time;
                    //console.dir(age);
                    $timeout(load_progress, Math.min(Math.max(age/2, 100), 60*1000)); 
                    /*
                    switch(scope.progress.status) {
                    case "finished":
                    case "canceled":
                    case "failed":
                        break;
                    default:
                        //TODO - I think every second is too frequent. look at the scope.progress.update_time, and only frequently if
                        //status has been updated recently
                        $timeout(load_progress, 1000); 
                    }
                    */
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


