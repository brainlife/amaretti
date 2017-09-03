#!/bin/bash

#This script is used inside the docker container to start api and ui(via http-server)

#if [ ! -f /app/api/config/auth.key ]; then
#    (
#    echo "generating auth.key/.pub"
#    cd /app/api/config
#    openssl genrsa -out auth.key 2048
#    chmod 600 auth.key
#    openssl rsa -in auth.key -pubout > auth.pub
#
#    echo "generating user.jwt"
#    node /app/bin/auth.js issue --scopes '{"common":["user"]}' --sub sca --out user.jwt
#    chmod 600 user.jwt
#    )
#fi

#dockerfile copies everything including the ssh-agent.sock file.. so I need to remove it before I start it
rm /app/ssh-agent.sock
ssh-agent -a /app/ssh-agent.sock

pm2 start /app/api/wf.js
pm2 start /app/bin/task.js
pm2 start /app/bin/resource.js

pm2 start http-server --name ui -- -p 80 -a 0.0.0.0 -d false /app/ui

pm2 logs
