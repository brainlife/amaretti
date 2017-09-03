
rm ssh-agent.sock
ssh-agent -a ssh-agent.sock

pm2 delete wf-api
pm2 start api/wf.js -i 2 --name wf-api --watch --ignore-watch="*.log test *.sh ui bin example .git"

pm2 delete wf-task
pm2 start bin/task.js --name wf-task --watch --ignore-watch="*.log test *.sh ui example .git"

pm2 delete wf-res
pm2 start bin/resource.js --name wf-res --watch --ignore-watch="*.log test *.sh ui example .git"

pm2 save
