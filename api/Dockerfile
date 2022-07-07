FROM node:16

MAINTAINER Soichi Hayashi <hayashis@iu.edu>

WORKDIR /app

COPY controllers .
COPY resource_test.sh .
COPY *.js ./

COPY package.json .
COPY package-lock.json .

RUN npm install --production
CMD [ "node", "server.js" ]
