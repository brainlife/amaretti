#DEBUG=sca:* env=dev PORT=12403 nodemon -i node_modules ./index.js

pm2 delete sca
pm2 start api/sca.js --watch --ignore-watch="\.log$ test .sh$ ui bin example"

pm2 delete sca-task
pm2 start bin/sca-task.js --watch --ignore-watch="\.log$ test .sh$ ui example"

pm2 delete sca-resource
pm2 start bin/sca-resource.js --watch --ignore-watch="\.log$ test .sh$ ui example"

pm2 save
