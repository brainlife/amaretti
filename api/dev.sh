#DEBUG=sca:* env=dev PORT=12403 nodemon -i node_modules ./index.js

pm2 delete sca
#pm2 start sca.js -i 4 --watch --ignore-watch="\.log$ test/ .sh$ pub/"
pm2 start sca.js --watch --ignore-watch="\.log$ test/ .sh$ pub/"

pm2 delete sca-task
pm2 start sca-task.js --watch --ignore-watch="\.log$ test/ .sh$ pub/"

pm2 save
