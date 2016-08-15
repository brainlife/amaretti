FROM centos:7

RUN yum -y install wget unxz

#install hsi
#COPY hpss/hsihtar-5.0.2.p5-RHEL6-64/* /bin/
RUN wget https://rt.uits.iu.edu/systems/storage/clients/hsi5.02/hsihtar-5.0.2.p5-RHEL6-64.tar.gz 
RUN tar -xzf *.tar.gz && mv hsihtar-5.0.2.p5-RHEL6-64/* /bin
RUN wget https://rt.uits.iu.edu/systems/storage/clients/hsi5.02/HPSS.conf -O /usr/local/etc/HPSS.conf

#install node 4.4
RUN wget https://nodejs.org/dist/v4.4.7/node-v4.4.7-linux-x64.tar.xz
RUN tar -xJf *.tar.xz 
ENV PATH=$PATH:/node-v4.4.7-linux-x64/bin

#install app
COPY . /app
WORKDIR /app
RUN npm install --production

#debug
#RUN ls -lart /usr/bin

CMD [ "npm", "start" ]

