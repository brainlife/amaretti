'use strict';
(function() {

var service = angular.module('sca-product-raw', [ 'app.config', 'toaster' ]);
service.directive('scaProductRaw', function(appconf, $http, toaster) {
    return {
        restrict: 'E',
        scope: {
            task: '=',
            product: '=',
        },
        templateUrl: 'products/raw/raw.html',
        link: function(scope, element) {
            scope.appconf = appconf;
            scope.jwt = localStorage.getItem(appconf.jwt_id);
            scope.product_id = scope.$parent.$index; //products.json is an array of products.. so I need index inside product
        }
    }
});
    
//end of IIFE (immediately-invoked function expression)
})();

