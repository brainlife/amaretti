'use strict';
(function() {

var product = angular.module('sca-product-blast', [ 'app.config', 'toaster' ]);

product.directive('scaProductBlastDb', function(appconf, $http, toaster) {
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
        }
    }
});

product.directive('scaProductBlastOut', function(appconf, $http, toaster) {
    return {
        restrict: 'E',
        scope: {
            task: '=',
            product: '=',
        },
        templateUrl: 'products/blast/out.html',
        link: function(scope, element) {
            scope.appconf = appconf;
            scope.jwt = localStorage.getItem(appconf.jwt_id);
            scope.product_idx = scope.$parent.$index; //products.json is an array of products.. so I need index inside product
            $http.get(appconf.api+"/product/blast/preview?t="+scope.task._id+"&p="+scope.product_idx)
            .then(function(res) {
                scope.preview = res.data;
            },
            function(res) {
                if(res.data && res.data.message) toaster.error(res.data.message);
                else toaster.error(res.statusText);
            });
        }
    }
});

product.directive('scaProductBlastFasta', function(appconf, $http, toaster) {
    return {
        restrict: 'E',
        scope: {
            task: '=',
            product: '=',
        },
        templateUrl: 'products/blast/fasta.html',
        link: function(scope, element) {
            scope.appconf = appconf;
            scope.jwt = localStorage.getItem(appconf.jwt_id);
        }
    }
});
    
})(); //end of IIFE (immediately-invoked function expression)
