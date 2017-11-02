---
layout: single
title: Technical Detail
permalink: /detail
sidebar:
  nav: "docs"
comments: true
---

## Background

A modern scientific workflow often involves computations on multiple computing architectures. For example, some parts of the workflow maybe most suited to be executed on large high throughput computing cluster where other parts may be executed on GPU or high memory capable clusters, or even some specialized VMs. The choice of resource may also depends on availability of certain applications, licenses, or current resource conditions. It is very rare that entire workflow can be computed on a single computing resource from beginning to the end, and user must often deal with choosing appropriate resources, and manage data transfer between those resources.

As scientific computing are also becoming more multi-disciplinary involving many different developers contributing to parts of the workflow with familarity to different types of computing systems. Also the size and scope of the computation necessary for their researches is increasing; the size of the input data often exceeds the capability of computing resource so that running the entire workflow on a single resource is not possible, or the number of inputs (or *subjects*) are simply too large to be practically handled by any single computing resource.

Researchers are often faced with learning how to use diverse set of computing architectures, programming languages and orchestrate the entire workflow across institutional boundaries or across different computing paradigms (HPC v.s HTC).

## About Amaretti

Amaretti is a simple REST API service that tries to address some of the issues. Please see [About Amaretti](/) for basic overview.

## Resource / Application trust model

Amaretti allows any developers to develop and register their apps through Amaretti. Before the app can be submitted, however, resource owner must approve the app to be executed on the resources. Each developer or project member should register their own resource (an account on their HPC systems) to execute their apps so that they can approve their own applications and quickly running their apps. Amaretti, however, allows resources to be shared among other users. This capability is used by Brain-Life platform to allow all new users to immediately start submitting applications through the platform using Brain-Life's shared resource.

We currently only allow administrator to share resources. By sharing resource with other users, an app may start running on resource that user may not want to run it on, as all input data must be staged to a remote resource prior to task execution and user might not want some sensitive data such as from their private projects to be sent to those resources. In the near future, we will implement a capability for users to *accept* shared resource offered by other users; most likely a member of their group. Then, we can start allowing non-administrator to share their resources with other users.

## Tasks

Tasks are the atomic unit of work executed on various computing resources. It could be a `job` for batch systems, or a vanilla process running on a vanilla VM that are kept track by its process ID.

## Service

Each ABCD compliant github repository represents `service`. User assign `service` when they submit a `task`, and Amaretti git clones specified `service`. For example, if user specifies `brain-life/app-life` as a service, Amaretti will git clones `https://github.com/brain-life/app-life` to create a workdir for that task under a chosen resource. 

## (Workflow) Instance

Amaretti provides workflow capability by creating dependencies between tasks. Tasks that depends on parent tasks will simply wait for those parent tasks to complete. All Amaretti tasks must belong to a workflow instance (or `instance` for short). `instance` organizes various tasks and not all tasks needs to be related to each other within a single `instance`. It is up to users to decide how best to organize their `tasks` within an `instance`.

## Resource

`Resource` is a remote computing resource where Amaretti can ssh and create workdir / git clone specified service and launch ABCD hook scripts to `start`, `stop`, and `monitor`. It could be a single VM, a head node of a large HPC cluster, or submit node for distributed HTC clusters like Open Science Grid.

In Amaretti, each task within the `instance` can run on different resources, and if a `service` is enabled on multiple resources Amaretti would pick the best resource based on variety of decision criterias (see below). The same workflow might, therefore, run on different set of resources each time the workflow is executed. 

## ABCD-spec 

Amaretti can run any service that are published on github.com as public repository and confirms to [ABCD Specification](https://github.com/brain-life/abcd-spec) This lightweight specification allows service developer to define `hooks` in a file named `package.json`.

```json
{
  "abcd": {
    "start": "start.sh",
    "stop": "stop.sh",
    "status": "status.sh"
  }
}
```

Each hook does following.

`start` starts the service on a resource (qsub, sbatch, singularity exec, etc..)
`monitor` gets executed periodically to monitor the service once it's started (query qstat, process ID, etc..)
`stop` How to stop the service (qdel, scancel, kill, etc..)

> `Hooks` are usually written in bash script but it can be any executable written in any language. 

When Amaretti starts a task, it creates a new directory containing a cloned git repository on the remote resource and set the current working directory to be in this directory. When a task is requested, user can specify configuration parameters and Amaretti passes this to the application by creating a file named `config.json` on the work directory where application can parse it when application is started.

All output files must be generated on the same work directory also. Application must not make any modification outside the work directory as they are considered immutable once each task completes and any changes will either corrupt the workflow or reverted by Amaretti during input staging step.

## Amendment to ABCD-spec

Each application can provide their own ABCD hook scripts, however, by default ABCD spec would now try to look for executable named `start`, `stop`, `status` on resource's default PATH. We are encouraging our developers to use these default scripts instead of providing app specific hook scripts themselves and asking resource provider to create these scripts to take most appropriate action on that resource. 

One important convention for ABCD default hook is that, `start` hook will look for an executable named `main` under the root directory of each application. `main` simply needs to run the application itself just like you normally would as if the application is run locally on developer's laptop. To support multiple resources, `main` can look for certain command / files installed on each resource and load appropriate dependencies. Please see (brain-life/app-life)[https://github.com/brain-life/app-life/blob/master/main] as an example.

With this amendment, most application simply needs to provide `main` in order to be *ABCD spec* compliant.

## JWT Authentication

JSON Web Token (JWT) [RFC7519](https://tools.ietf.org/html/rfc7519) is a simple authentication token consisting of base64 encoded JSON object containing user ID, token expiration date, issuer, authorization scopes and various other information about the user. It also contains a digital signature to verify the authenticity of the token issued by an authentication service.

For a web application, user typically interacts with JWT token in following order

1. User visits authentication service UI (login form) and enters login credentials (such as user/pass) and authentication service authenticates.
2. If authentication is successful, service will generate the JWT token and user receives the token. Token is usually stored on user's browser through cookie or localStorage. 
3. User then make request for application that truest the JWT issued by the authentication service. User usually sets `authentication: Bearer` header with their API request
4. Application receives the API request and token from the user. Application verify the token by decrypting the token using authentication's public key (using JWT's client libraries). If the token is valid, it uses information stored on the token (user ID, authorization settings, etc) and proceed to fulfill the API request.

### Auth-E-ntication through JWT

JWT token allows us to perform stateless authentication of user; eliminating a need to query authentication service to validate the token and/or query user authorization every time user makes a API call. This removes the authentication service as SPOF (single-point-of-failurer) and allows us to easily scale our API servers while reducing latency for each API calls. In fact, the only time authentication service is needed is when user tries to login to our system. Once logged in, users are immune to the outage caused by authentication service to certain extent. Similarity to oauth2 token, JWT tokens are meant to be refreshed periodically (once a hour) by contacting the authentication service with old token and receive a new token.

> Setting the short expiration date for JWT token minimizes the risk of a token misused or authorization granted when it shouldn't.

### Auth-O-rization through JWT

JWT token can contain any json object such as user's ID / profile / email, etc. Our authentication token stores authorization object as part of our token. For example..

```
{
  "warehouse": [
    "admin",
    "user"
  ],
  "profile": [
    "user"
  ]
}
```

When our API receives this token, it can lookup what authorization is given to which service simply by looking at this object. 

## RESTful API

Client applications can interface with Amaretti through its RESTful API. 

> TODO..

Please see [API Doc](/apidoc/) for more details.

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

`requested`

When a task is first submitted, it is placed under `requested` status. Task handler will wait for all parent tasks to finish, and synchronize outputs from any parent tasks computed on outside resources.

`running`

A task has been submitted to the local job scheduler such as PBC, slurm, Kubernetes, etc.. and currently pending execution, or the job is actually being executed on the compute resources. Amaretti does not distinguish between those 2 conditions. Amaretti will periodically monitor jobs status of all running tasks at an appropriate interval (once a few seconds to once an hour). Application can report the status detail as `status message` to the user by echoing any text to stdout via monitoring hook.

`failed` [terminal]

A task has failed to start, or execution of the job has failed. The task will remain in this state until the task is re-requested, or removed.

`stop_requested`

If user request to stop a running task, it must first be placed under `stop_requested` state. Amaretti's task handler will then run the stop ABCD hook script and if successful, the task will be placed under `stopped` state.

`stopped` [terminal]

Once the task is stopped, it will remain in this state until the task is re-requested or removed.

`running_sync`

Only used under special circumstances.

`removed` [terminal]

All work directories will be removed eventually by Amaretti or the cluster administrator. When all task directories that belongs to a task have been removed, Amaretti will reset the task state to `removed`.

`finished` [terminal]

A task has completed successfully. Output from the task will eventually be removed by Amaretti (at the date set by remove_date) or by the resource itself (such as HPC data purging policy)

## "Kicking tasks down the road"

Amaretti handles requested tasks simply by going through all currently active tasks stored in MongoDB. Each tasks has `next_date` which instructs Amaretti's task handler when it should *re-visit* the task and perform any actions necessary based on the task status. "Kicking cans down the road" is a crude but accurate depiction of this model. For example, when Amaretti *visits* a running task, it first sets `next_date` based on how long the task has been running to cause timing similar to exponential backoff. Amaretti won't recheck the task that has not met `next_date` criteria when searching for tasks to handle next. 

For newly requested tasks, task handler first updates the `next_date` to 1 hour in the future by default, and  it then tries to initialize and start the task. If it fails to start the task for whatever the reason, the same task will automatically handled in 1 hour. If it succeeds to start the task, `next_date` will be set so that the status of the task will be immediately checked for the first time.

Amaretti must deal with variety of remote resources with unforseen sets of possible error conditions that we can not determine if it is temporal or permanent. We could implement a similar system using Message Queue or 3rd party scheduling libraries, however, our simple task handling approach has so far allowed us with enough error resilience / failover capabilities, and with adequate task handling throughput. 

## Task Versioning

When a user submits a task request, user can specify the repository branch/tag name as well as the name of the service. When a service is executed, it simply git clones the specified branch rather than the master branch by default. This allows user to execute specific version of the app while allowing developers to continue developing / modifying the app without negatively impacting existing users of the app. It also provides provenance information necessary to recreate the output of the app using the same code as it was initially executed.

However, developer could continue updating published branch, or update which commit the tag points to. They often do this to back-port some critical bugs fixes or branches are simply used as master branch of specific version of their software. It is up to each developer to understand the consequence of updating the branch/tag and communicate with the users about the modifications, although we recommend developers to not make any changes to branches other than applying critical bug fixes.

## Task Dependencies

Tasks can chained together to form a directed acyclic graph through a use of task dependencies. When a task is submitted with dependencies, a requested task will only start running when all of the parent tasks complete successfully. Amaretti will run  tasks concurrently as long as all of its parent tasks has completed successfully and has resource to run those tasks.

If any of the parent task fails, the child task will also be marked as failed and failure will then cascade to all of its children. When a user rerun a failed parent, and if the failed task completes successfully the second time, all child tasks will be also re-requested.

Tasks connected through dependencies can be interpreted as a logical "workflow", but Amaretti itself does not provide the concept of "workflow" natively. To help organize related tasks, Amaretti provides "instance". "Instance" is simply a grouping of tasks and user is free to define what "instance" means; it could be tasks that process the same subject, or tasks that runs certain application on multiple subjects. Not all tasks within an instance need to be connected through dependencies. However, all task must belong to a specific instance. 

> Amaretti creates parent directories for each instances on the remote resource where all work directories for each task will be placed under.

> (Inter-instance dependency) A task can have dependency with tasks from another instances.

## Work directory synchronization

All ABCD compliant application should generate output files on the current working directory. Therefore, a work directory of a parent task can be used as input directory of child tasks. If both parent and child tasks are on the same resource, child task can simply read from the parent tasks through the local file path. If they are not on the same resource, however, Amaretti will transfer the working directory of the parent task to the resource that the child task will be executed on. Amaretti uses rsync through ssh to do the data transfer, and it does this whenever a child task is requested in case a parent task might have modified data since the last transfer due to parent task being rerun. 

Let's assume that parent task T1 is running on a resource R1 and a child task T2 is running on a resource R2. Before task T2 can run, work directory for task T1 must be synchronized from resource R1 to R2. As Amaretti can ssh to both R1 and R2, it could simply transfer data between 2 resources by using Amaretti as a ssh tunnel. However, it is very inefficient, and ideally we want to transfer data directly between R1 and R2. Amaretti accomplishes this by using ssh-agent with a temporary ssh key installed to access R1 and forward the agent to R2, then from R2 initiating rsync(pull) from R1 using the forwarded ssh key allowing R2 to access R1. The ssh key for R1 is immediately purged from the agent as soon as R2 connects to R1. 

(Figure?)

Often, remote resource becomes unavailable due to scheduled maintenance, or unexpected outages, etc., which would prevent subsequent tasks from executing on different resources as Amaretti will not be able to synchronize the data on unavailable resource to another resource, even though another resources might be available. Or, user won't be able to download / view data stored on the resource if the resource is unavailable even though the task itself has finished successfully. In the future, we will allow Amaretti to synchronize its output to a *cache* resources when a task is finished (or even periodically during the task execution). Cache resource is a special remote resource used to store copy of the work directories. If the resource that holds the original output files are unavailable, Amaretti could fall back to the cache resource to allow subsequent tasks to rsync the input data from the cache resource for better availability. 

## Work directory purging

Some HPC systems relies on data purging policy to reduce scratch disk usage by removing any files that are not recently accessed. As Amaretti supports multiple work directories per task, it periodically goes through each remote to find which resource the task's work directory still exist (there could be synchronized to more than 1 resource) and when it realizes that there are no more resources, it will automatically mark the task status as `removed`.

Amaretti itself also purges old work directories after 25 days of task completion by default. Submitter can set the removal date of the task if the output should be removed sooner. Any final output from workflow that should be persisted needs to be downloaded or copied to a permanent data archive once tasks are completed.

## Resource Testing

Amaretti periodically goes through all registered remote computing resources and checks for their statues. If the resource is inaccessible, or can not reach its work directory, Amaretti will temporarily flags the resource to be down so that resource selection algorithm can avoid using that resource to submit requested tasks. If there are no resource to submit a task, requested task will remain in that status until the resource becomes available again.

## Downloading from work directory

Amaretti provides API to list and download files and directories from remote resources associated with the task. Directories are converted to .tar on the fly. Unlike the resource-to-resource data transfer, the data must travel from remote resource through Amaretti's API server, on to the API client. The API provides user a quick and convenient way to export data out of the task. A platform like Brain-Life uses this API to implement on-browser file browser.

> We are going to update this so that API can download data from task regardless of which resource the task currently has synchronized data

## SSH Connection Cache

Amaretti interfaces with remote resources primarily through ssh and sftp. To reduce the latency of opening new connections and to also reduce the number of total open ssh connections, Amaretti uses connection cache and make use of OpenSSH multi-channel capabilities with capability to defer request in case the channels are full.
