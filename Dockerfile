FROM node:6

MAINTAINER Soichi Hayashi <hayashis@iu.edu>

RUN npm install http-server -g && \
    npm install pm2 -g && \
    pm2 install pm2-logrotate

#install hsi
#COPY hpss/hsihtar-5.0.2.p5-RHEL6-64/* /bin/
#RUN wget https://rt.uits.iu.edu/systems/storage/clients/hsi5.02/hsihtar-5.0.2.p5-RHEL6-64.tar.gz 
#RUN tar -xzf *.tar.gz && mv hsihtar-5.0.2.p5-RHEL6-64/* /bin
#RUN wget https://rt.uits.iu.edu/systems/storage/clients/hsi5.02/HPSS.conf -O /usr/local/etc/HPSS.conf

COPY . /app
RUN cd /app && npm install --production && cd ui && npm install --production

EXPOSE 80
EXPOSE 8080

CMD [ "/app/docker/start.sh" ]

