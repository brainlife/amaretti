'use strict';
(function() {

var service = angular.module('sca-product-blast-db', [ 'app.config', 'toaster' ]);
service.directive('scaProductBlastDb', function(appconf, $http, toaster) {
    return {
        restrict: 'E',
        scope: {
            task: '=',
            product: '=',
        },
        templateUrl: 'products/blast/db.html',
        link: function(scope, element) {
            scope.appconf = appconf;
            scope.jwt = localStorage.getItem(appconf.jwt_id);
            //scope.product_id = scope.$parent.$index; //products.json is an array of products.. so I need index inside product
        }
    }
});
    
})(); //end of IIFE (immediately-invoked function expression)
