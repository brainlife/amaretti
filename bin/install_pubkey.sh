#!/bin/bash

#this script is meant to be executed via ssh2.Client.exec like following
#conn.exec('wget --no-check-certificate https://raw.githubusercontent.com/soichih/sca/master/bin/install_pubkey.sh -O - | PUBKEY=\"'+pubkey+'\" COMMENT=\"'+comment+'\" bash', function(err, stream)..

if [ -z "$PUBKEY" ]; then
        echo "Please set PUBKEY in ENV"
        exit 1
fi

#make sure ~/.ssh exists
mkdir -p ~/.ssh
chmod 700 ~/.ssh

#install pubkey (if it's not already there)
grep --regexp "^$PUBKEY" ~/.ssh/authorized_keys > /dev/null 2> /dev/null
ret=$?
if [ ! $ret -eq 0 ]; then
        echo "Adding key to authorized_keys"
        if [ ! -z "$COMMENT" ]; then
                echo "## $COMMENT" >> ~/.ssh/authorized_keys
        fi
        echo $PUBKEY >> ~/.ssh/authorized_keys
fi
if [ $ret -eq 0 ]; then
        echo "The key is already installed"
fi

#make sure authorized_keys has valid mod
chmod 600 ~/.ssh/authorized_keys


