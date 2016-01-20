'use strict';
(function() {

var product = angular.module('sca-product-raw', [ 'app.config', 'toaster' ]);

product.directive('scaProductRaw', function(appconf, $http, toaster) {
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
            scope.product_idx = scope.$parent.$index; //products.json is an array of products.. so I need index inside product
        }
    }
});
    
//end of IIFE (immediately-invoked function expression)
})();

