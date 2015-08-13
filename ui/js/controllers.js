'use strict';

/*
 * Right now, we are going to have a single module for our app which contains
 * all controllers. In the future, we should refactor into multiple modules. When I do, don't forget
 * to add it to app.js's module list
 * */

var controllers = angular.module('scaControllers', [
    'ui.bootstrap',
]);

controllers.controller('AboutController', ['$scope', 'appconf', '$route', 'toaster', '$http', 'jwtHelper', '$cookies', '$routeParams', '$location', 'redirector',
function($scope, appconf, $route, toaster, $http, jwtHelper, $cookies, $routeParams, $location, redirector) {

    //var $redirect = $routeParams.redirect ? $routeParams.redirect : "#/user";
    //allow caller to specify redirect url via ?redirect param

    $scope.title = appconf.title;
    $scope.logo_400_url = appconf.logo_400_url;
    //console.dir(jwt);
    //toaster.pop('error', 'title', 'Hello there');
    //toaster.pop('success', 'title', 'Hello there');
    //toaster.pop('wait', 'title', 'Hello there');
    //toaster.pop('warning', 'title', 'Hello there');
    //toaster.pop('note', 'title', 'Hello there');
    //toaster.success('title', 'Hello there');
    //toaster.error('title', 'Hello there');

    var jwt = localStorage.getItem(appconf.jwt_id);
    if(jwt != null && !jwtHelper.isTokenExpired(jwt)) {
        toaster.pop('note', 'You are already logged in');
        //DEBUG
        var token = jwtHelper.decodeToken(jwt);
        console.log(token);
    }

    //sometime we get error messages via cookie (like iucas registration failurer)
    var messages = $cookies.get("messages");
    if(messages) {
        JSON.parse(messages).forEach(function(message) {
            toaster.pop(message.type, message.title, message.message);
        });
        $cookies.remove("messages", {path: "/"}); //TODO - without path, it tries to remove cookie under /auth path not find it
    }
}]);


