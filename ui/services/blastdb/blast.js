
'use strict';
(function() {

var service = angular.module('sca-service-blast', [ 'app.config', 'toaster', 'ui.select' ]);

service.directive('scaStepBlast', function(appconf, $http, toaster, resources) {
    return {
        restrict: 'E',
        scope: {
            workflow: '=',
        }, 
        templateUrl: 'services/blastdb/blast.html',
        link: function(scope, element) {
            scope.step = scope.workflow.steps[scope.$parent.$index];
            var config = scope.step.config; //just shorthand
            scope.dbs = [
                { group: "ncbi", id: "nr", name: "NCBI NR", desc: "Non-redundant protein sequences from GenPept, Swissprot, PIR, PDF, PDB, and NCBI RefSeq"},
                { group: "ncbi", id: "nt", name: "NCBI NT", desc: "Partially non-redundant nucleotide sequences from all traditional divisions of GenBank, EMBL, and DDBJ excluding GSS,STS, PAT, EST, HTG, and WGS."},
                { group: "ncbi", id: "pdbaa", name: "NCBI pdbaa", desc: "Sequences for the protein structure from the Protein Data Bank"},
                { group: "ncbi", id: "pdbnt", name: "NCBI pdbnt", desc: "Sequences for the nucleotide structure from the Protein Data Bank. They are NOT the protein coding"},
            ];

            if(config.db) scope.dbs.forEach(function(db) {
                if(db.id == config.db && db.group == config.source) scope.selected_db = db;
            });
            scope.select_db = function(item, model) {
                config.source = item.group;
                config.db = item.id;
                scope.$parent.save_workflow();
            }

            scope.compute_resources = []; 
            resources.getall().then(function(myresources) {
                myresources.forEach(function(r) {
                    if(r.type == "pbs") scope.compute_resources.push(r);
                });

                if(scope.compute_resources.length == 0) toaster.error("You do not have any computing resource capable of staging blast db");
                
                //pick the first compute resource 
                //TODO - pick the most appropriate one instead
                config.compute_resource_id = scope.compute_resources[0]._id;
            });

            scope.submit = function() {
                var name = config.name||'untitled '+scope.step.service_id+' task '+scope.step.tasks.length;
                $http.post(appconf.api+'/task', {
                    step_id: scope.$parent.$index, //step idx
                    workflow_id: scope.workflow._id,
                    service_id: scope.step.service_id,
                    name: name,
                    resources: {
                        compute: config.compute_resource_id,
                    },
                    config: config,
                }).then(function(res) {
                    scope.step.tasks.push(res.data.task);
                }, function(res) {
                    if(res.data && res.data.message) toaster.error(res.data.message);
                    else toaster.error(res.statusText);
                });
            }
        }
    };
});
    
//end of IIFE (immediately-invoked function expression)
})();

