'use strict';

app.controller('AboutController', ['$scope', 'appconf', 'menu', 'serverconf', 'scaMessage', 'toaster', 'jwtHelper',
function($scope, appconf, menu, serverconf, scaMessage, toaster, jwtHelper) {
    scaMessage.show(toaster);
    $scope.appconf = appconf;
}]);

app.controller('HeaderController', ['$scope', 'appconf', '$route', 'serverconf', 'menu',
function($scope, appconf, $route, serverconf, menu) {
    $scope.title = appconf.title;
    serverconf.then(function(_c) { $scope.serverconf = _c; });
    $scope.menu = menu;
    $scope.user = menu.user; //for app menu
}]);

