---
layout: single
title: Installation
permalink: /installation
sidebar:
  nav: "docs"
comments: true
---

## Dependencies

Amaretti requires following depenencies - at minimum. 

* MongoDB 
* Redis (mainly used to store health status from various microservices)
* RabbitMQ (event bus)
* [Event Service (soichih/event)](https://github.com/soichih/event) 
* [Authentication Service (soichih/auth)](https://github.com/soichih/auth) (or any JWT-generating service would do)
* Web proxy such as Nginx

Optional Components

* [Progress Service (soichih/progress)](https://github.com/soichih/progress)
* [Profile Service (soichih/profile)](https://github.com/soichih/profile)

You can install all of these component with Docker. Please read README on each services.

## Amaretti

### Configuration

TODO. Exaplain how to create config.

### Install Amaretti

```bash
docker run \
    --name workflow \
    -v `pwd`/config:/app/config \
    -d soichih/workflow
```

### Exposing Amaretti REST API

You can expose Amaretti, event or auth services through a web proxy such as Nginx.

Here is a sample nginx configuration

```
server {
    listen 443 ssl http2;
    server_name dev1.soichi.us;

    ssl     on;
    ssl_certificate /etc/letsencrypt/live/dev1.soichi.us/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dev1.soichi.us/privkey.pem;

    proxy_redirect off;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto  https;

    ###################################################

    location /auth/ {
        proxy_pass http://auth/;
    }
    location /auth/config.js {
        alias /config/auth/config.js;
    }
    location /api/auth/ {
        proxy_pass http://auth:8080/;
    }

    ###################################################

    location /profile/ {
        proxy_pass http://profile/;
    }
    location /profile/config.js {
        alias /config/profile/config.js;
    }
    location /api/profile/ {
        proxy_pass http://profile:8080/;
    }

    ###################################################

    location /event/ {
        proxy_pass http://event/;
    }
    location /event/config.js {
        alias /config/event/config.js;
    }
    location /api/event/ {
        proxy_pass http://event:8080/;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }

    ###################################################

    location /amaretti/ {
        proxy_pass http://amaretti/;
    }
    location /amaretti/config.js {
        alias /config/amaretti/config.js;
    }
    location /api/amaretti/ {
        proxy_pass http://amaretti:8080/;
        client_max_body_size 5G;
        proxy_read_timeout 3600;
    }
}
```
