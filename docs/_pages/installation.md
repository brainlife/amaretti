---
layout: single
title: Installation
permalink: /installation/
sidebar:
  nav: "docs"
---

TODO..

Create config directory containing all necessary configurations.

### Run via Docker

```bash
docker run \
    --name workflow \
    -v `pwd`/config:/app/config \
    -d soichih/workflow
```

