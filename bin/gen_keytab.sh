#!/bin/sh                                                                                                                                                                           
if [ -z "$USERNAME" ]; then
        echo "Please set USERNAME in ENV"
        exit 1
fi
if [ -z "$PASSWORD" ]; then
        echo "Please set PASSWORD in ENV"
        exit 1
fi

keytab_name="/tmp/.sca.$USERNAME.$RANDOM.keytab"

#clean up previous keytab if exists
rm -f $keytab_name

path=~/.sda-backup/
ktutil > /dev/null <<INTER
addent -password -p $USERNAME@ADS.IU.EDU -k 1 -e rc4-hmac
$PASSWORD
addent -password -p $USERNAME@ADS.IU.EDU -k 1 -e aes256-cts
$PASSWORD
write_kt $keytab_name
quit
INTER

if [ $? -eq 0 ]; then
    base64 $keytab_name
    rm $keytab_name #remove keytab!
    exit 0
else
    echo "failed to create keytab"
    exit 1
fi
