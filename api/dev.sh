#DEBUG=sca:* env=dev PORT=12403 nodemon -i node_modules ./index.js

pm2 delete sca
pm2 start sca.js --watch --ignore-watch="\.log$ test/ .sh$ pub/"
