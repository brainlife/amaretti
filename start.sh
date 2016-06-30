#DEBUG=sca:* env=dev PORT=12403 nodemon -i node_modules ./index.js

pm2 delete sca-wf
pm2 start api/sca.js --name sca-wf --watch --ignore-watch="\.log$ test .sh$ ui bin example"

pm2 delete sca-wf-task
pm2 start bin/sca-task.js --name sca-wf-task --watch --ignore-watch="\.log$ test .sh$ ui example"

pm2 delete sca-wf-resource
pm2 start bin/sca-resource.js --name sca-wf-resource --watch --ignore-watch="\.log$ test .sh$ ui example"

pm2 save
