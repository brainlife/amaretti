---
layout: single
title: Technical Detail
permalink: /detail
sidebar:
  nav: "docs"
---

## *Meta* Workflow Orchestration Service

A complex scientific workflow often involves computations on multiple computing resourcess. For example, some parts of the workflow maybe most suited to be executed on large high throughput computing cluster where other parts may be executed on GPU or high memory capable clusteres, or even VMs. The choice of resource may also depends on availablity of certain applications, licenses, or current resource conditions. It is very rare that entire workflow can be computed on a single computing resource from beginning to the end, and user must often deal with choosing appropriate resources, and manage data transfer between those resources.

This is particularly true for workflow involving "Big Data"; where the size of the input data exceeds the capability of a computing resources, or the number of inputs (number of `subjects`) are simply too large to be practically handled by a single computing resource.

Researchers then must learn how to use those diverse set of resources and orchestrate the entire workflow across institutional boundaries or across different computing paradigms such as HPC v.s. DHTC.  

A goal of Amaretti is to provide a layer on top of various computing resources, and allow users to orchestrate their workflows by handling data transfer between resources, determine which resource to run requested services, and monitor task status. Amaretti relies on local batch systems, or workflow orchestration libraries to actually run programs on each computing resources. Therefore, Amaretti can be considered to be a `meta` workflow orchestration service.

## About Amaretti Service

Amaretti is a collection of microservices written in nodejs, and administrator can install it on docker. User interacts with Amaretti through REST API, and a single instance of Amaretti can support multiple users. A user allows Amaretti to access their computing resources by configuring public ssh key generated for each resource. A user can then send a request to run tasks, and Amaretti will take care of determining where to run those tasks, staging input data, start and monitor the task.

Amaretti can run any service as long as it is published on public github repo, the serice is configured by the resoure administrator, and user has access to the resource that the service is enabled.

## ABCD-spec 

Amaretti can run any service that confirms to [ABCD Specification](https://github.com/brain-life/abcd-spec) This lightweight specification allows service developer to define `hooks` which will do following operations.

1. How to start the service on a resource.
2. How to monitor the service once it's started.
3. How to stop the service once it's started.

These `hooks` can be defined by creating a file called `package.json` on the root directory of the git repository. 

```json
{
  "scripts": {
    "start": "start.sh",
    "stop": "stop.sh",
    "status": "status.sh"
  }
}
```

When Amaretti wants to start this app, it first git clone the repository on a shared file system on a remote system, then looks up the `start` hook (in this case "start.sh") and execute that script to start the application. It is up to the application developer to decide how to start/stop/monitor the application based on types of resources the application is executed on. Normally, it is a simple bash script which executes `qsub` or `sbatch`, or run process directly on gthe login/submit host.

When Amaretti starts a task, it creates an empty work directory on the remote resource and set the current working directory to be in this work directory. An  applications can receive input parameters from `config.json` created by Amaretti on the work directory, and output all output files to the same work directory. Application must not make any modification outside the work directory as they are considered immutable once each task completes and any changes will either corrupt the workflow or reverted by Amaretti during input staging step.

## Termonologies

### Tasks

Tasks are the atomic unit of work executed on various computing resources. It could contain a `job` on batch systems, or an entire `workflow` submitted on a single resource. On VM, a task could simply be a process running on each machine and kept track by its process ID.

### Service

...

### Workflow Instance

Amaretti provides workflow capability simply by specifying dependencies between tasks. Tasks that depends on parent tasks will simply wait for those parent tasks to complete. All Amaretti tasks must belong to a workflow instance which is simply a grouping of related tasks. User can use workflow instance (in Amaretti it is simply called an `instance`) to organize tasks, or use it as `meta`-workflow, or as a `process` as it is called by Brain-Life warehouse service.

## JWT Token

write me..

## Resource Selection

A service startup hook can be written such that it can support multiple computing resources based on environment parameter set on each resource. If there are more than 1 resource that the service can run, Amaretti will decide which resource to run the service at runtime by computeing the *score* for each resource based on varaiety of criterias.

First, when a resource administrator enables a service, the administrator can pick a default score where higher score means it is more likely that the resource should be chosen. If the same service is configured on mutiple resources with different resource administrators, administrators should discuss and agree on appropriate scores for each resouce.

At runtime, Amaretti then computes the final resource score with following order.

1. Find the default score configured for the resource for the service. If not configured, the resource is disqualified from being used.
2. If the resource status is non-OK status (periodically tested by resource monitor service), the resource is disqualified.
3. For each task dependencies, +5 to the score if the resource is used to run the dependent tasks. This increases the chance of re-using the same resource where the previous task has run and output data is locally available.
4. +10 to the score if user owns the resource, rather than shared. If user has their own resource account, we should use that it as it often has better queue priority, or accessibility to better hardware, etc..
5. +15 to the score if the resource is specified in `preferred resource id` as specified by the submitter.

The resource with the highest score will be chosen to execute the task and a report of why the given resource was chosen is added to `_env.sh` created inside task's working directory. Following is a sample of this content.

```
#!/bin/bash
# task id        : 59bdb27d4cddb5002461c94d (run 1 of 1)
# resource       : brlife@carbonate.uits.iu.edu
# task dir       : /N/dc2/scratch/brlife/carbonate-workflows/59b9dedd4cddb5002461b869/59bdb27d4cddb5002461c94d
export SERVICE_DIR="$HOME/.sca/services/brain-life/app-life"
export INST_DIR="/N/dc2/scratch/brlife/carbonate-workflows/59b9dedd4cddb5002461b869"
export PROGRESS_URL="https://brain-life.org/api/progress/status/_sca.59b9dedd4cddb5002461b869.59bdb27d4cddb5002461c94d"
export ENV="IUHPC"
export HPC="CARBONATE"

# why was this resource chosen?
# brlife@karst (shared) (5845c8ceff35844a88494323)
#    tasks running:0 maxtask:400
#    resource.config score:4
#    user owns this.. +10
#    final score:14
#    
# brlife@carbonate (5943cd40055b490021abb7b6)
#    tasks running:43 maxtask:400
#    resource.config score:5
#    resource listed in deps/resource_ids.. +5
#    user owns this.. +10
#    final score:20
#    
# azure1 (59600fb09a28ce0024cdd5dd)
#    tasks running:0 maxtask:1
#    resource.config score:10
#    user owns this.. +10
#    final score:20
#    
# azure-slurm1 (5978e0b7abf0be0023d118f4)
#    tasks running:0 maxtask:3
#    resource.config score:10
#    user owns this.. +10
#    final score:20

```

Other criteria 

## Task Status

Amaretti task can have following task statues.

`requested``con

When a task is first submitted, it is placed under `requested` status. Task handler will wait for all parent (dependending) tasks to finish, and synchronize outputs from any parent tasks computed on outside resources.

`running`

A task has been submitted to the local job scheduler such as PBC, Slurm, Kubernetes, etc.. and currently pending execution, or the job is actually being executed on the compute resources. Amaretti does not distinguish between those 2 states, but application can report the status detail as `status message` to the user. Amaretti will periodically monitor jobs status of all running tasks at certain invertal.

`failed (terminal)`

A task has failed to start, or execution of the job has failed. The task will remain in this state until the task is re-requested, or removed.

`stop_requested`

If user request to stop a running task, it must first be placed under `stop_requested` state. Amaretti's task handler will then run the stop ABCD hook script and if successful, the task will be placed under `stopped` state.

`stopped (terminal)`

Once the task is stopped, it will remain in this state until the task is re-requested or removed.

`running_sync`

Only used under special circumstances.

`removed (terminal)`

All work directories will be removed eventually by Amaretti or the cluster administrator. 

`finished (terminal)`

## TODO.. I will write following subjects 

- Submits, monitors, and manages large number of tasks.
- Error tolerant. It can handle varaiety of error conditions and resume operations when systems recovers.

- Applications are hosted on github and maintained by individual developers.
- Git branch can be specified by users to run particular versions of the application.
- Handles task dependencies to form a workflow. Mulitple tasks can be logically grouped.
- Synchronizes input/output data if a task cross resource boundaries.
- Restart failed tasks if requested.
- Maximum runtime can be specified.
- Output from task execution can be removed at specified date.


- Allows resource owners to decide which ABCD compliant applications to run.
- Resource can be shared by multiple users.
- Any computing resource that allows ssh access can be used as remote resource (HPC systems, VMs, clusters, etc..)
- Continously monitor resource status and prevents apps from being submitted if no resources are available.
- Decides best resource to submit requested apps with preconfigured scores and user preference and current conditions.


- RESTful APIs.
- Auth-e/o through JWT token.
- Stateless (It can be installed across multiple nodes for scalability / high availability)
- Uploading / downloading of files to/from remote resources.
- ssh-agent 
