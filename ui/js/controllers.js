'use strict';

/*
 * Right now, we are going to have a single module for our app which contains
 * all controllers. In the future, we should refactor into multiple modules. When I do, don't forget
 * to add it to app.js's module list
 * */

app.controller('AboutController', ['$scope', 'appconf', '$route', 'toaster', '$http', 'jwtHelper', '$cookies', '$routeParams', '$location', 
function($scope, appconf, $route, toaster, $http, jwtHelper, $cookies, $routeParams, $location) {

    //var $redirect = $routeParams.redirect ? $routeParams.redirect : "#/user";
    //allow caller to specify redirect url via ?redirect param

    var jwt = localStorage.getItem(appconf.jwt_id);
    $scope.profile = {};
    if(jwt) {
        var user = jwtHelper.decodeToken(jwt);
        $http.get(appconf.profile_api+'/public/'+user.sub)
        .success(function(profile, status, headers, config) {
            $scope.profile = profile;
        })
        .error(function(data, status, headers, config) {
            if(data && data.message) {
                toaster.error(data.message);
            }
        });
    }


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

    /*
    var jwt = localStorage.getItem(appconf.jwt_id);
    if(jwt != null && !jwtHelper.isTokenExpired(jwt)) {
        toaster.pop('note', 'You are already logged in');
        //DEBUG
        var token = jwtHelper.decodeToken(jwt);
        console.log(token);
    }
    */
    //load menu
    $http.get(appconf.shared_api+'/menu')
    .success(function(menu) {
        $scope.menu = menu;

        /*
        //massage menu before setting
        var user_menu = findMenuItem('user', menu);
        //user_menu.label = $scope.form_profile.fullname;
        user_menu.label =
        */

        //split menu into each menues
        menu.forEach(function(m) {
            switch(m.id) {
            case 'top':
                $scope.top_menu = m;
                break;
            case 'settings':
                $scope.settings_menu = m;
                break;
            }
        });
    });

    //sometime we get error messages via cookie (like iucas registration failurer)
    var messages = $cookies.get("messages");
    if(messages) {
        JSON.parse(messages).forEach(function(message) {
            toaster.pop(message.type, message.title, message.message);
        });
        $cookies.remove("messages", {path: "/"}); //TODO - without path, it tries to remove cookie under /auth path not find it
    }
}]);


