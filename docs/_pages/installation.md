---
layout: single
title: Installation
permalink: /installation/
sidebar:
  nav: "docs"
---

## Dependencies

Amaretti requires following depenencies - at minumum. 

* MongoDB 
* Redis (mainly used to store health status from various microservices)
* RabbitMQ (event bus)
* [Event Service](https://github.com/soichih/event) 
* [Authentication Service](https://github.com/soichih/auth) (or any JWT-generating service would do)
* Amaretti itself

You can install all of these component with Docker.

## Amaretti

### Configuration

TODO. Exaplain how to create config.

### Run Amaretti

```bash
docker run \
    --name workflow \
    -v `pwd`/config:/app/config \
    -d soichih/workflow
```

### Exposing Amaretti REST API

TODO..
