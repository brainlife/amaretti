---
layout: single
title: Detail
permalink: /detail
sidebar:
  nav: "docs"
---

## *Meta* Task Orchestration Service

A complex scientific workflow often involves computations on multiple computing resourcess. Some parts of the workflow maybe most suited to be executed on a certain computing resource where other parts might be executed elsewhere based on availablity of applications, capabilities of the resource, and current resource conditions (busy, down, etc..) It is very rare that entire workflow can be computed on a single resource from beginning to the end, and user must often deal with transferring intermediate output files between those resources.

This is particularly true for workflow involving "Big Data"; where the size of the input data exceeds the capability of the resources on at least certain parts of the workflow where specialized computing resource is necessary, and/or the number of inputs (number of `subjects`) are too large to be effectively handled by any single resource.

Researchers then must learn how to use those diverse set of resources and orchestrate the entire workflow across institutional boundaries and/or different computing paradigms such as HPC v.s. DHTC.  A goal of Amaretti is to provide a common layer on top of various computing resources, and allow users to easily orchestrate their workflow through CLI (command-line-interface) or the RESTful API. 

## ABCD-spec 

Beside having access to the resource, and be able to transfer data between resources, Amaretti needs to have following information so that it can effectively orchestrate a workflow.

1. How to install the service on a resource.
2. How to start the service on a resource.
3. How to monitor the service once it's started.
4. (optionally) How to stop the service once it's started (if user requests)

We have defined a sipmle specification called [ABCD Spec](https://github.com/brain-life/abcd-spec) independently of Amaretti which allows application developers to programaticly answer above questions through a series of script which we call "hooks". `Hooks` can be defined by creating a file called `package.json` on the root directory of the git repository for each application. 

```json
{
  "scripts": {
    "start": "start.sh",
    "stop": "stop.sh",
    "status": "status.sh"
  }
}
```

When Amaretti wants to start this app, it first git clone the repository on a shared file system on a remote system, then lookup the `start` hook (in this case "start.sh") and execute that script to start the application. It is up to the application developer to decide how to start/stop/monitor the application based on the type of resource that the application is executed in, but it is normally a simple bash script which executes `qsub` or `sbatch` on submit scripts depending on the type of resources that the application supports.

When Amaretti starts a task, it creates an empty work directory on the remote resource and set the current working directory to be in this work directory. ABCD compliant applications can receive any applicaiton configuration parameters from `config.json` created by Amaretti on the work directory, and output any output files to the same work directory. Although `config.json` may contain paths to input files existing outside this work directory, application should not make any modification on files outside off the work directory. 

## Working Directory

TODO..

Amaretti assumes that all work directories are temporarly. 


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
