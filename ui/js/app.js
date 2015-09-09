'use strict';

var app = angular.module('app', [
    'app.config',
    'ngSanitize',
    'ngRoute',
    'ngAnimate',
    'ngCookies',
    'toaster',
    'angular-loading-bar',
    'angular-jwt',
    'ui.bootstrap',
    'sca',
]);

/*
app.factory('redirector', ['$location', '$routeParams', function($location, $routeParams) {
    if($routeParams.redirect) {
        localStorage.setItem('post_auth_redirect', $routeParams.redirect);
    }
    return {
        //redirect to specified url
        //returns true if redirecting out of the page
        go: function() {
            var redirect = localStorage.getItem('post_auth_redirect');
            if(redirect) {
                console.log("redirecting to "+redirect);
                localStorage.removeItem('post_auth_redirect');
                document.location = redirect;
                return true;
            } else {
                console.log("no post_auth_redirect set.. doing to /user");
                $location.path("/user")
                return false;
            }
        }
    }
}]);
*/

//show loading bar at the top
app.config(['cfpLoadingBarProvider', function(cfpLoadingBarProvider) {
    cfpLoadingBarProvider.includeSpinner = false;
}]);

//configure route
app.config(['$routeProvider', 'appconf', function($routeProvider, appconf) {
    $routeProvider.
    when('/about', {
        templateUrl: 't/about.html',
        controller: 'AboutController'
    })
    /*
    .when('/success', {

        templateUrl: 't/empty.html',
        controller: 'SuccessController'
    })
    .when('/resetpass', {
        templateUrl: 't/resetpass.html',
        controller: 'ResetpassController'
    })
    .when('/register', {
        templateUrl: 't/register.html',
        controller: 'RegisterController'
    })
    .when('/user', {
        templateUrl: 't/user.html',
        controller: 'UserController',
        requiresLogin: true
    })
    */
    .otherwise({
        redirectTo: '/about'
    });
    
    //console.dir($routeProvider);
}]).run(['$rootScope', '$location', 'toaster', 'jwtHelper', 'appconf', function($rootScope, $location, toaster, jwtHelper, appconf) {
    $rootScope.$on("$routeChangeStart", function(event, next, current) {
        //redirect to /login if user hasn't authenticated yet
        if(next.requiresLogin) {
            var jwt = localStorage.getItem(appconf.jwt_id);
            if(jwt == null || jwtHelper.isTokenExpired(jwt)) {
                toaster.warning("Please login first");
                localStorage.setItem('post_auth_redirect', next.originalPath);
                $location.path("/login");
                event.preventDefault();
            }
        }
    });
}]);

//configure httpProvider to send jwt unless skipAuthorization is set in config (not tested yet..)
app.config(['appconf', '$httpProvider', 'jwtInterceptorProvider', 
function(appconf, $httpProvider, jwtInterceptorProvider) {
    jwtInterceptorProvider.tokenGetter = function(jwtHelper, config, $http) {
        //don't send jwt for template requests
        if (config.url.substr(config.url.length - 5) == '.html') {
            return null;
        }
        var jwt = localStorage.getItem(appconf.jwt_id);
        if(!jwt) return null; //not jwt
        var expdate = jwtHelper.getTokenExpirationDate(jwt);
        var ttl = expdate - Date.now();
        if(ttl < 0) {
            console.log("jwt expired");
            return null;
        } else if(ttl < 3600*1000) {
            console.dir(config);
            console.log("jwt expiring in an hour.. refreshing first");
            //jwt expring in less than an hour! refresh!
            return $http({
                url: appconf.api+'/refresh',
                skipAuthorization: true,  //prevent infinite recursion
                headers: {'Authorization': 'Bearer '+jwt},
                method: 'POST'
            }).then(function(response) {
                var jwt = response.data.jwt;
                //console.log("got renewed jwt:"+jwt);
                localStorage.setItem(appconf.jwt_id, jwt);
                return jwt;
            });
        }
        return jwt;
    }
    $httpProvider.interceptors.push('jwtInterceptor');
}]);


