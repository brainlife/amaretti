#!/bin/bash

## These three lines will cause stdout/err to go a logfile as well
LOGFILE=install.log
exec > >(tee -a ${LOGFILE})
exec 2> >(tee -a ${LOGFILE} >&2)

#debug..
#env | sort | grep SCA

echo "installing sca shared libs"

mkdir -p services
mkdir -p bin

#install node
nodeversion=node-v4.2.4-linux-x64
if [ ! -d bin/$nodeversion ]; then
    echo "installing $nodeversion"
    echo "TODO.. downloading from nodejs.org/dist is superslow.. I should cache this somewhere"
    (cd bin && curl https://nodejs.org/dist/v4.2.4/$nodeversion.tar.gz | tar -xz)
fi
ln -sf node-v4.2.4-linux-x64 bin/node #for easy export
export PATH=$PATH:~/.sca/bin/node/bin

if [ ! -d node_modules/underscore-cli ]; then
    echo "installing underscore-cli"
    npm install underscore-cli #to use, export PATH=$PATH:~/.sca/node_modules/underscore-cli/bin
fi
