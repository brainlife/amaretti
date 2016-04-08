'use strict';

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

app.factory('workflows', ['appconf', '$http', function(appconf, $http) {
    return {
        get: function() {
            return $http.get(appconf.api+'/workflow')
            .then(function(res) {
                return res.data;
            });
        },
        getInsts: function() {
            return $http.get(appconf.api+'/instance')
            .then(function(res) {
                return res.data;
            });
        },
        createInst: function(workflowid) {
            return $http.post(appconf.api+'/instance/'+workflowid, {
                name: '',
                desc: '',
            });
        }
    }
}]);

app.factory('resources', ['appconf', '$http', 'serverconf', 'toaster', 
function(appconf, $http, serverconf, toaster) {
    var resources = null;

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

/*
app.directive('match', function () {
  return {
    require: 'ngModel',
    link: function (scope, elm, attrs, ctl) {
        scope.$watch(attrs['match'], function (errorMsg) {
            console.dir(elm[0]);
            //ui-select doesn't have setCustomValidity?
            //elm[0].setCustomValidity(errorMsg);
            ctl.$setValidity('match', errorMsg ? false : true);
        });
    }
  };
});
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
