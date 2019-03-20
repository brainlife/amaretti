
#using docker container now
#rm ssh-agent.sock
#ssh-agent -a ssh-agent.sock

pm2 delete amaretti
pm2 start api/wf.js --name amaretti --watch --ignore-watch="*.log test *.sh ui bin example .git"

pm2 delete amaretti-task
pm2 start bin/task.js --name amaretti-task --watch --ignore-watch="*.log test *.sh ui example .git"

pm2 delete amaretti-resource
pm2 start bin/resource.js --name amaretti-resource --watch --ignore-watch="*.log test *.sh ui example .git"

pm2 delete amaretti-remove-workdir
pm2 start bin/remove_workdirs.js --name amaretti-remove-workdir --watch --ignore-watch="*.log test *.sh ui example .git"

pm2 save
