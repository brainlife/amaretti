---
layout: single
title: Technical Detail
permalink: /detail
sidebar:
  nav: "docs"
---

> DRAFT

## *Meta* Workflow Orchestration Service

A complex scientific workflow often involves computations on multiple computing resources. For example, some parts of the workflow maybe most suited to be executed on large high throughput computing cluster where other parts may be executed on GPU or high memory capable clusters, or even VMs. The choice of resource may also depends on availability of certain applications, licenses, or current resource conditions. It is very rare that entire workflow can be computed on a single computing resource from beginning to the end, and user must often deal with choosing appropriate resources, and manage data transfer between those resources.

This is particularly true for workflow involving "Big Data"; where the size of the input data exceeds the capability of a computing resources, or the number of inputs (or *subjects*) are simply too large to be practically handled by a single computing resource.

Researchers then must learn how to use those diverse set of resources and orchestrate the entire workflow across institutional boundaries or across different computing paradigms such as HPC v.s. DHTC.

Also, as scientific workflow becomes more complex, different parts of the workflow maybe required to run on certain resources simply because they are developed by different developers with familarity to different types of resources, such is the case for Brain-Life where each app can be executed in resources that developers intended to run it on.

A goal of Amaretti is to provide a layer on top of various computing resources, and allow client applications to orchestrate their workflows by handling data transfer between resources, determine which resource to run requested services, and monitor task status. Amaretti relies on local batch systems, or workflow orchestration libraries to actually run programs on each computing resources. Therefore, Amaretti can be considered to be a `meta` workflow orchestration service.

## About Amaretti Service

Amaretti is a collection of microservices written in nodejs, and administrator can install via on docker. Client applications interact with Amaretti through REST API, and a single instance of Amaretti can support multiple users. A user allows Amaretti to access their computing resources by configuring public ssh key generated for each resource. A user can then send a request to run tasks, and Amaretti will take care of determining where to run those tasks, staging input data, start and monitor the task.

Amaretti relies on local batch systems, or intra-cluster workflow orchestration libraries to run applications on each computing resources. Amaretti, therefore, can be considered to be a `meta` workflow orchestration service.

Amaretti can run any service that are published on github.com as public repository and confirms to [ABCD Specification](https://github.com/brain-life/abcd-spec) This lightweight specification allows service developer to define `hooks` which will do following operations.

## ABCD-spec 

Amaretti can run any application that confirms to [ABCD Specification](https://github.com/brain-life/abcd-spec). This lightweight specification allows service developer to define `hooks` to do following.

```json
{
  "abcd": {
    "start": "start.sh",
    "stop": "stop.sh",
    "status": "status.sh"
  }
}
```
1. Start the service on a resource (qsub, sbatch, singularity exec, etc..)
2. Monitor the service once it's started (query qstat, process ID, etc..)
3. How to stop the service (qdel, scancel, kill, etc..)

hooks are usually written with bash script, and it can handle multiple resources by checking ENV parameters and detect which resource it is running on. When Amaretti wants to start an app, it first git clones the application repository on a remote system, which becomes a "workdir" where all output files from the application is written to, then executes the start hook to start the application.

When Amaretti starts a task, it creates a new directory containing a cloned git repository on the remote resource and set the current working directory to be in this directory. When a task is requested, user can specify configuration parameters and Amaretti passes this to the application by creating a file named `config.json` on the work directory where application can parse it prior to application execution.  

All output files must be generated on the same work directory also. Application must not make any modification outside the work directory as they are considered immutable once each task completes and any changes will either corrupt the workflow or reverted by Amaretti during input staging step.

## Amendment to ABCD-spec

Applications receives all input parameters from `config.json` created by Amaretti inside the workdir. Application will use any json parser available for programming langauge that the application is written in. Application must not make any modification outside the work directory as they are considered immutable once each task completes. Any changes will either corrupt other workflow or overwritten by Amaretti.

Each application can provide their own ABCD hook scripts, however, by default ABCD spec would now try to look for executable named `start`, `stop`, `status` on resource's default PATH. We are encouraging our developers to use these default scripts instead of providing app specific hook scripts themselves and asking resource provider to create these scripts to take most appropriate action on that resource. 

One important convention for ABCD default hook is that, `start` hook will look for an executable named `main` under the root directory of each application. For PBS cluster, `star` would treat `main` as PBS submit script, for example. 

With this amendment, most application simply needs to provide the `main` in order to be *ABCD spec* compliant. 

## Terminologies

### Tasks

Tasks are the atomic unit of work executed on various computing resources. It could be a `job` for batch systems, or an entire `workflow` submitted on a single resource. On VM, a task could simply be a process running on each machine and kept track by its process ID.

### Service

Each ABCD compliant github repository represents `service`. User assign `service` when they submit a `task`, and Amaretti git clones specified `service`. For example, if user specifies `brain-life/app-life` as a service, Amaretti will git clones `https://github.com/brain-life/app-life` to create the workdir for that task under a chosen resource. 

### (Workflow) Instance

Amaretti provides workflow capability by creating dependencies between tasks. Tasks that depends on parent tasks will simply wait for those parent tasks to complete. All Amaretti tasks must belong to a workflow instance (or `instance` for short). `instance` organizes various tasks and not all tasks needs to be related to each other within a single `instance`. It is up to users to decide how best to organize their `tasks` within an `instance`.

### Resource

`Resource` is a remote computing resource where Amaretti can ssh and create workdir / git clone specified service and launch ABCD hook scripts to `start`, `stop`, and `monitor`. It could be a single VM, a head node of a large HPC cluster, or submit node for distributed HTC clusters like Open Science Grid. 

In Amaretti, each task within the `instance` can run on different resources, and if a `service` is enabled on multiple resources Amaretti would pick the best resource based on variety of decision criterias (see below). The same workflow might, therefore, run on different set of resources each time the workflow is executed. 

## JWT Auentication

JSON Web Token (JWT) [RFC7519](https://tools.ietf.org/html/rfc7519) is a simple authentication token consisting of base64 encoded JSON object containing user ID, token expiration date, issuer, authorization scopes and various other information about the user. It also contains a digital signature to verify the authenticity of the token issued by an authentication service. 

JWT token allows us to perform stateless authentication of user; eliminating Amaretti a need to query authentication service  to validate the token and/or query user authorization every time user makes a API call. This removes the authentication service as SPOF (single-point-of-failurer) and allows us to horizontally scale our API servers while reducing latency for each API calls. 

## Resource Selection

When a user has access to multiple resources where a service can be executed, Amaretti must make decision as to which resource to use to submit the task.

First of all, when a resource owner enables a service on any resource, the owner can pick a default score for the service where higher score means it is more likely that the resource will be chosen.

At runtime, Amaretti then computes the final resource score with following order.

1. Find the default score configured for the resource for the service. If not configured, the resource is disqualified from being used.
2. If the resource status is non-OK status (periodically tested by resource monitor service), the resource is disqualified.
3. For each task dependencies, +5 to the score if the resource is used to run the dependent tasks. This increases the chance of re-using the same resource where the previous task has run and output data is locally available.
4. +10 to the score if user owns the resource, rather than shared. If user has their own resource account, we should use that it as it often has better queue priority, or accessibility to better hardware, etc..
5. +15 to the score if the resource is specified in `preferred resource id` as specified by the submitter.

The resource with the highest score will be chosen to execute the task and a report why the given resource was chosen is added to `_env.sh` created inside task's working directory. Following is a sample of this content.

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

## Task Status

Amaretti `task` can have following task statues.

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
