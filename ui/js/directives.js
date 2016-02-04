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
                    if(!res.data) {
                        console.log("failed to load progress");
                        return;
                    }

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

            /*
            function reload_products() {
                return $http.get(appconf.api+"/product/bytaskid/"+scope.task._id)
                .then(function(res) {
                    res.data.forEach(function(product) {
                        scope.step.products.push(product);
                    });
                }, function(res) {
                    if(res.data && res.data.message) toaster.error(res.data.message);
                    else toaster.error(res.statusText);
                });
            }
            */
            
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


