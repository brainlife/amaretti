---
layout: single
title: Introduction
permalink: /
sidebar:
  nav: "docs"
---

## About Amaretti

Amaretti is a light-weight inter-resource task orchestration service. It allows user to request *applications* hosted in Github to be executed on user's resources and automate the staging of input and output data between resources in a secure fashion. Amaretti orchestrates workflow executed across multiple resources and use local job schedulers to execute jobs on computing resources. Amaretti exposes its functionalities through RESTful API.

You can organize tasks into a workflow by specifying dependencies between each tasks, and Amaretti will handle concurrency, retry (on different resource if necessary), data transfer, and clean up of the task directories.

Amaretti allows external developer to develop and register apps to run through Amaretti while resource owner gets to decide which apps are allowed to execute on their resources. Developers can create an app that runs on their familiar computing platform (HTC, HPC, MapReduce, etc..) and users can easily construct a meta-workflow across heterogeneous computing platforms.

Amaretti is primarily used by Brain-Life.org project and design to meet its unique goals, but it can be installed and used independently for other projects. Amaretti itself does not provide all necessary features often required by science gateway applications. For example, Brain-Life portal uses Amaretti with various other services such as Authentication, Progress, Warehouse and Event services to provide all features required by the platform. 

We are releasing Amaretti as an independent open source project in a hope that other groups might find it useful. 

## Functionalities

Amaretti provides following capabilities.

### Task Orchestration

- Submits, monitors, and manages large number of tasks.
- Error tolerant. It can handle varaiety of error conditions and resume operations when systems recovers.
- Applications are hosted on github and maintained by individual developers.
- Git branch can be specified by users to run particular *versions* of the application.
- Handles task dependencies to form a workflow. Mulitple tasks can be logically grouped. 
- Synchronizes input/output data if a task cross resource boundaries.
- Restart(retry) failed tasks if requested.
- Maximum runtime can be specified.
- Output from task execution can be removed at specified date.

### Resource Management

- Allows resource owners to decide which [ABCD compliant](https://github.com/brain-life/abcd-spec) applications to run.
- Resource can be shared by multiple users.
- Any computing resource that allows ssh access can be used as remote resource (HPC systems, VMs, clusters, etc..)
- Continously monitor resource status and prevents apps from being submitted if no resources are available.
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
