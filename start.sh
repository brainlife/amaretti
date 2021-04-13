
#to run the stack locally

pm2 delete amaretti
pm2 start api/wf.js --name amaretti-api --watch --ignore-watch="*.log test *.sh ui bin example .git"

#for all tasks
pm2 delete amaretti-task 
pm2 start bin/task.js --name amaretti-task --watch --ignore-watch="*.log test *.sh ui example .git"

#for ui tasks (nonice)
pm2 delete amaretti-task-nonice
pm2 start bin/task.js --name amaretti-task-nonice --watch --ignore-watch="*.log test *.sh ui example .git" -- --nonice

pm2 delete amaretti-resource
pm2 start bin/resource.js --name amaretti-resource --watch --ignore-watch="*.log test *.sh ui example .git"

pm2 delete amaretti-remove-workdir
pm2 start bin/remove_workdirs.js --name amaretti-remove-workdir --watch --ignore-watch="*.log test *.sh ui example .git"

pm2 save
