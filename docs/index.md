---
layout: single
title: About
permalink: /
sidebar:
  nav: "docs"
comments: true
---

Amaretti is a light-weight, cross-resource, multi-user task orchestration service written in nodejs. Amaretti is a meta processing managment system; it provides cross-resource orchestration relying on the individual resources batch scheduling systems. It manages computation execution and data management across multiple architectures (e.g., clouds and high-performance computing). Its purpose is to reduce the users' management burden, facilitate data-intensive research and development and accelerate discovery. 

Amaretti provides RESTful API functionality to orchestrate the execution of tasks across compute resources. Amaretti (1) determines the best resource to use for computing a task, (2) stages the data, (3) start, (4) monitors and (5) provides data transfer mechanisms between tasks and users. Amaretti is not a batch job scheduler and it should not be used as a replacement for workflow service. Indeed, it relies on resources-specific batch processing systems (such as PBS/torque, HTCondor or Slurm) to schedule and manage processing.

Any computer allowing ssh access (e.g. through ssh keys) can be registered as a compute resource. Amaretti users can register their own resources or access resources shared by other users.  Multiple tasks can be pipelined by users to create logical workflows. Task pipelines are informed by specifying dependencies between tasks. Amaretti will handle concurrency, retry (on a different resource if necessary), data transfer between resources, and clean up of the task directories with the workflows. Amaretti allows users to execute *apps* hosted on Github on resources where the user has access to. Application can be developed and registered by any 3rd party developer but it needs to be approved and enabled by each resource owner. Amaretti uses *hook* scripts as described by [ABCD specification](https://github.com/brain-life/abcd-spec) provided by each application or installed on compute resource to perform requested actions on each resources.

Amaretti was developed to support www.Brain-Life.org, but it can be installed and used independently. Amaretti itself does not provide all necessary features often required by science gateway applications. For example, Brain-Life portal uses Amaretti with various other services such as Authentication, Progress, Warehouse and Event services to provide all features required by the platform. 

We are releasing Amaretti as an independent open source project in a hope that other groups will find it useful. 

## Capabilities

### Task Orchestration

- Highthroughput. Submit, monitor and manage large number of computational tasks.
- Cross-platform. Synchronize tasks input and output data across resource boundaries.
- Resilience. Handle multiple error conditions and automatically resume operations at system recovery.
- Task dependencies. Handle multiple tasks and tasks dependencies across resources to form tasks meta-workflows.
– Applications. Applications are hosted on github.com and maintained by *App* developers. Individual, git branches can be specified by developers and users to run particular *versions* of each *App*.

### Resource Management

- Allows resource owners to decide which [ABCD compliant](https://github.com/brain-life/abcd-spec) applications to run.
- Resource can be shared by multiple users.
- Any computing resource that allows ssh access can be used as remote resource (HPC systems, VMs, clusters, etc.)
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
