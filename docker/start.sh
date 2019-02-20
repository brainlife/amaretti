#!/bin/bash

#This script is used inside the docker container to start api and ui(via http-server)

#dockerfile copies everything including the ssh-agent.sock file.. so I need to remove it before I start it
#rm /app/ssh-agent.sock
#ssh-agent -a /app/ssh-agent.sock

#pm2 start -i 2 /app/api/wf.js
pm2 start /app/api/wf.js
pm2 start /app/bin/task.js
pm2 start /app/bin/resource.js

pm2 start http-server --name ui -- -p 80 -a 0.0.0.0 -d false /app/ui

pm2 logs
