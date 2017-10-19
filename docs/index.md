---
layout: single
title: Introduction
permalink: /
sidebar:
  nav: "docs"
---

## About Amaretti

Amaretti is a light-weight inter-resource task orchestration service. It allows user to request *applications* hosted in Github to be executed on configured resources that user owns (can be shared) and handles inter-resource data transfer in a secure fasion. Amaretti does not replace local job schedulers which might be installed on remote computing resources. In a sense, Amaretti is a *meta* task orchestration service. An applications submitted by Amaretti depeneds on local job schedulers to actually execute the jobs in most appropriate manner. Amaretti takes care of starting / monitoring of those jobs submitted on varaiety of computing resources and provide RESTful API where client application can submit task requests and receive events.

You can organize tasks into a workflow by specifying dependencies between each tasks, and Amaretti will handle concurrencies, retry (on different resource if necessary), data transfer and clean up of the task directories.

One unique aspect of Amaretti is its ability to execute apps developed by external developers. Any developer can develop and register apps to run via Amaretti, however, resource owner gets to decide which apps are allowed to execute on their resources. 

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
