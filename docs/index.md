---
layout: single
title: About
permalink: /
sidebar:
  nav: "docs"
---

(TODO - I need to polish this)

Amaretti is a light-weight cross-resource, multi-user task orchestration service written in nodejs. Client applications interact with Amaretti through REST API. A user gives Amaretti access to their computing resources by configuring public ssh key generated for each resource. A user can then send a request to run tasks, and Amaretti will take care of determining where to run those tasks, staging input data, start and monitor the task through ssh. Any computers that allows ssh access through ssh key can be used as a remote computing resource by Amaretti (HPC, clusters, Vanilla VMs, etc)

You can organize tasks into a workflow by specifying dependencies between each tasks, and Amaretti will handle concurrency, retry (on different resource if necessary), data transfer, and clean up of the task directories.

Amaretti allows user to request *applications* hosted in Github to be executed on user's resources and automate the staging of input and output data between resources in a secure fashion. 

Amaretti is not a batch job scheduler and it should not be used as a replacement for one. Amaretti does not provide resource management, scheduling, and other capabilities often provided by various batch processing system. Amaretti only provides capability necessary to orchestrate cross-resource workflows while taking advantage of existing functionalities provided by local batch scheduler. 

Amaretti relies on *hook* scripts as described by [ABCD specification](https://github.com/brain-life/abcd-spec) provided by each application (or resource itself) to perform required actions on remote resources. To execute an application, most hook scripts submits to local batch systems like PBS, slurm, or other workflow orchestration libraries like hadoop. Amaretti can be considered as a *meta* workflow orchestration service, as it is a thin layer that presides resource specific workflows by determining which resource to run requested services, handling necessary data transfer between each resources, and executing hook scripts on those resources to start, stop and monitor task status while they are executed by using appropriate mechanism necessary for each resource.

There are systems such as [GlideinWMS](http://glideinwms.fnal.gov/doc.prd/index.html) that allows local jobs to be submitted to number of other resources, but the goal for such systems usually focuses on extending the capability of an existing batch submission system and requires substantial amount of efforts by both submitter and resource owner to properly configure them.

Amaretti allows external developer to develop and register apps to run through Amaretti while resource owner gets to decide which apps are allowed to execute on their resources. Developers can create an app that runs on their familiar computing platform (HTC, HPC, MapReduce, etc..) and users can easily construct a meta-workflow across heterogeneous computing platforms.

Amaretti is primarily used by Brain-Life.org project and design to meet its unique goals, but it can be installed and used independently for other projects. Amaretti itself does not provide all necessary features often required by science gateway applications. For example, Brain-Life portal uses Amaretti with various other services such as Authentication, Progress, Warehouse and Event services to provide all features required by the platform. 

We are releasing Amaretti as an independent open source project in a hope that other groups might find it useful. 

## Capabilities

### Task Orchestration

- Submits, monitors, and manages large number of tasks.
- Error tolerant. It can handle variety of error conditions and resume operations when systems recovers.
- Applications are hosted on github and maintained by individual developers.
- Git branch can be specified by users to run particular *versions* of the application.
- Handles task dependencies to form a workflow.
- Synchronizes input/output data if a task cross resource boundaries.
- Restart(retry) failed tasks if requested.
- Maximum runtime (retries) can be specified.
- Output from task execution can be removed at specified date.

### Resource Management

- Allows resource owners to decide which [ABCD compliant](https://github.com/brain-life/abcd-spec) applications to run.
- Resource can be shared by multiple users.
- Any computing resource that allows ssh access can be used as remote resource (HPC systems, VMs, clusters, etc..)
- Continuously monitor resource status and prevents apps from being submitted if no resources are available.
- Decides best resource to submit requested apps with preconfigured *scores* and user preference and current conditions.

### API

- RESTful APIs.
- Auth-e/o through JWT token. 
- Stateless (It can be installed across multiple nodes for scalability / high availability)
- Uploading / downloading of files to/from remote resources.

## Software Stack

Amaretti is implemented with following software.

- Node.js / express for REST API
- MongoDB (mongoose)
- RabbitMQ (amqp) to publish workflow events
- Redis for current status caching
- (optional) Angular1 based web UI for resource configuration

## License

MIT; A permissive free software license with very limited restriction on reuse and with an excellent license compatibility.
