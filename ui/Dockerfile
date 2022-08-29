FROM node:16

COPY . /ui
WORKDIR /ui

RUN npm install

ENTRYPOINT [ "npm", "run", "dev" ]
