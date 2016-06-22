var app = angular.module('app', [
    'app.config',
    'ngRoute',
    'ngAnimate',
    'ngCookies',
    'toaster',
    'angular-loading-bar',
    'angular-jwt',
    'ui.gravatar',
    'ui.select',
    'ui.bootstrap',
    'ui.bootstrap.tooltip',
    'sca-shared',
]);

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
        controller: 'WorkflowsController',
        requiresLogin: true
    })

    //detail for each workflow 
    .when('/workflow/:id', {
        templateUrl: 't/workflow.html',
        controller: 'WorkflowController',
        requiresLogin: true
    })
    
    //list of all currently running workflows
    .when('/insts', {
        templateUrl: 't/insts.html',
        controller: 'InstsController',
        requiresLogin: true
    })
    
    .when('/services', {
        templateUrl: 't/services.html',
        controller: 'ServicesController',
        requiresLogin: true
    })
    /*
    .when('/task/:instid/:taskid', {
        templateUrl: 't/task.html',
        controller: 'TaskController',
    })
    */

    //allows user to edit list of resources that user has access to
    .when('/resources', {
        templateUrl: 't/resources.html',
        controller: 'ResourcesController',
        requiresLogin: true
    })
    .otherwise({
        redirectTo: '/workflows'
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

//can't quite do the slidedown animation through pure angular/css.. borrowing slideDown from jQuery..
app.animation('.slide-down', ['$animateCss', function($animateCss) {
    return {
        enter: function(elem, done) {
            $(elem).hide().slideDown("fast", done);
        },
        leave: function(elem, done) {
            $(elem).slideUp("fast", done);
        }
    };
}]);

//show loading bar at the top
app.config(['cfpLoadingBarProvider', function(cfpLoadingBarProvider) {
    cfpLoadingBarProvider.includeSpinner = false;
}]);

//configure httpProvider to send jwt unless skipAuthorization is set in config (not tested yet..)
app.config(['appconf', '$httpProvider', 'jwtInterceptorProvider', 
function(appconf, $httpProvider, jwtInterceptorProvider) {
    jwtInterceptorProvider.tokenGetter = function(jwtHelper, config, $http) {
        //don't send jwt for template requests (I don't think angular will ever load css/js - browsers do)
        if (config.url.substr(config.url.length - 5) == '.html') return null;
        return localStorage.getItem(appconf.jwt_id);
    }
    $httpProvider.interceptors.push('jwtInterceptor');
}]);

app.factory('serverconf', ['appconf', '$http', function(appconf, $http) {
    return $http.get(appconf.api+'/config')
    .then(function(res) {
        return res.data;
    });
}]);

//load menu and profile by promise chaining
app.factory('menu', ['appconf', '$http', 'jwtHelper', '$sce', 'scaMessage', 'scaMenu', 'toaster',
function(appconf, $http, jwtHelper, $sce, scaMessage, scaMenu, toaster) {

    var jwt = localStorage.getItem(appconf.jwt_id);
    var menu = {
        /*
        header: {
            label: appconf.brand.label,
            //icon: $sce.trustAsHtml("<img src=\""+appconf.icon_url+"\">"),
            //url: appconf.home_url,
        },
        */
        top: scaMenu,
        user: null, //to-be-loaded
        _profile: null, //to-be-loaded
    };
    if(appconf.icon_url) menu.header.icon = $sce.trustAsHtml("<img src=\""+appconf.icon_url+"\">");
    if(appconf.home_url) menu.header.url = appconf.home_url
    if(jwt) menu.user = jwtHelper.decodeToken(jwt);

    /*
    //TODO - maybe I should set up interval inside application.run()
    var jwt = localStorage.getItem(appconf.jwt_id);
    if(jwt) {
    }
    */

    if(menu.user) {
        $http.get(appconf.profile_api+'/public/'+menu.user.sub).then(function(res) {
            menu._profile = res.data;
            /* 
            //TODO this is a bad place to do this, because requested page will still be loaded
            //and flashes the scaMessage added below
            if(menu.user) {
                //logged in, but does user has email?
                if(!res.data.email) {
                    //force user to update profile
                    //TODO - do I really need to?
                    scaMessage.info("Please update your profile before using application.");
                    sessionStorage.setItem('profile_settings_redirect', window.location.toString());
                    document.location = appconf.profile_url;
                }
            }
            */
        });
    }
    return menu;
}]);

//http://plnkr.co/edit/juqoNOt1z1Gb349XabQ2?p=preview
/**
 * AngularJS default filter with the following expression:
 * "person in people | filter: {name: $select.search, age: $select.search}"
 * performs a AND between 'name: $select.search' and 'age: $select.search'.
 * We want to perform a OR.
 */
app.filter('propsFilter', function() {
  return function(items, props) {
    var out = [];

    if (angular.isArray(items)) {
      items.forEach(function(item) {
        var itemMatches = false;

        var keys = Object.keys(props);
        for (var i = 0; i < keys.length; i++) {
          var prop = keys[i];
          var text = props[prop].toLowerCase();
          if (item[prop].toString().toLowerCase().indexOf(text) !== -1) {
            itemMatches = true;
            break;
          }
        }

        if (itemMatches) {
          out.push(item);
        }
      });
    } else {
      // Let the output be the input untouched
      out = items;
    }

    return out;
  };
});

//https://gist.github.com/thomseddon/3511330
app.filter('bytes', function() {
    return function(bytes, precision) {
        if(bytes == 0) return '0 bytes';
        if (isNaN(parseFloat(bytes)) || !isFinite(bytes)) return '-';
        if (typeof precision === 'undefined') precision = 1;
        var units = ['bytes', 'kB', 'MB', 'GB', 'TB', 'PB'],
            number = Math.floor(Math.log(bytes) / Math.log(1024));
        return (bytes / Math.pow(1024, Math.floor(number))).toFixed(precision) +  ' ' + units[number];
    }
});

app.filter('reverse', function() {
    return function(items) {
        return items.slice().reverse();
    };
});

app.factory('resources', ['appconf', '$http', 'serverconf', 'toaster', 'jwtHelper',
function(appconf, $http, serverconf, toaster, jwtHelper) {
    var resources = null;

    //needed to figure out if user has write access
    var jwt = localStorage.getItem(appconf.jwt_id);
    if(jwt) jwt = jwtHelper.decodeToken(jwt);

    //return all devices configured for the user
    function getall() {
        return serverconf.then(function(serverconf) {
            return $http.get(appconf.api+'/resource')
            .then(function(res) {
                //console.log("got serverconf and resources");
                resources = res.data;
                resources.forEach(function(resource) {
                    //console.dir(resource);
                    resource.detail = serverconf.resources[resource.resource_id];
                    if(jwt) resource._canedit = (resource.user_id == jwt.sub);
                });
                return resources;
            }, function(res) {
                if(res.data && res.data.message) toaster.error(res.data.message);
                else toaster.error(res.statusText);
            });
        });
    }

    //find available resources that mathces criteria (empty means no match)
    function find(criteria) {
        return getall().then(function() {
            var matches = [];
            resources.forEach(function(resource) {
                if(criteria.type && resource.type != criteria.type) return;
                matches.push(resource); 
            });

            //TODO sort the mathces so that the best resource goes to [0]
            return matches;
        }); 
    }

    //add to resources 
    function add(resource_id) {
        //just in case..
        return serverconf.then(function(serverconf) {
            var def = serverconf.resources[resource_id];  
            $http.post(appconf.api+'/resource', {
                type: def.type,
                resource_id: resource_id,
                config: def.default
            })      
            .then(function(res) {
                resources.push(res.data);
            }, function(res) {
                if(res.data && res.data.message) toaster.error(res.data.message);
                else toaster.error(res.statusText);
            });
        });
    }

    function upsert(resource) {
        return $http.put(appconf.api+'/resource/'+resource._id, resource);
    }

    return {
        getall: getall, 
        upsert: upsert,
        find: find,

        add: add, //just add to resources array - doesn't save it
    }
}]);

app.factory('services', ['appconf', '$http', 'serverconf', 'toaster', 
function(appconf, $http, serverconf, toaster) {
    var services = null;

    //return all devices configured for the user
    function query(q) {
        //TODO send q to server
        return serverconf.then(function(serverconf) {
            return $http.get(appconf.api+'/service')
            .then(function(res) {
                services = res.data;
                return services;
            }, function(res) {
                if(res.data && res.data.message) toaster.error(res.data.message);
                else toaster.error(res.statusText);
            });
        });
    }

    /*
    function upsert(service) {
        return $http.put(appconf.api+'/service/'+service._id, service);
    }
    */

    return {
        query: query, 
        //upsert: upsert,
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

/*
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
*/

//https://github.com/angular-ui/ui-select/issues/258
app.directive('uiSelectRequired', function() {
  return {
    require: 'ngModel',
    link: function(scope, elm, attrs, ctrl) {
      ctrl.$validators.uiSelectRequired = function(modelValue, viewValue) {
        //return modelValue && modelValue.length;
        return modelValue != "";
      };
    }
  };
});

//http://plnkr.co/edit/YWr6o2?p=preview
app.directive('ngConfirmClick', [
    function() {
        return {
            link: function (scope, element, attr) {
                var msg = attr.ngConfirmClick || "Are you sure?";
                var clickAction = attr.confirmedClick;
                element.bind('click',function (event) {
                    if ( window.confirm(msg) ) {
                        scope.$eval(clickAction)
                    }
                });
            }
        };
    }
]);

app.factory('groups', ['appconf', '$http', 'jwtHelper', 'toaster', function(appconf, $http, jwtHelper, toaster) {
    return $http.get(appconf.auth_api+'/groups')
    .then(function(res) {
        return res.data;
    }, function(res) {
        if(res.data && res.data.message) toaster.error(res.data.message);
        else toaster.error(res.statusText);
    });
}]);

