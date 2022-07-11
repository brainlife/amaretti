FROM node:16

COPY . /apps/amaretti
WORKDIR /apps/amaretti/api
RUN npm install
