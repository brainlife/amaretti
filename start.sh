#DEBUG=sca:* env=dev PORT=12403 nodemon -i node_modules ./index.js

rm ssh-agent.sock
ssh-agent -a ssh-agent.sock

pm2 delete workflow
pm2 start api/wf.js -i 2 --name workflow --watch --ignore-watch="*.log test *.sh ui bin example"

pm2 delete workflow-task
pm2 start bin/sca-task.js --name workflow-task --watch --ignore-watch="*.log test *.sh ui example"

pm2 delete workflow-resource
pm2 start bin/sca-resource.js --name workflow-resource --watch --ignore-watch="*.log test *.sh ui example"

pm2 save
