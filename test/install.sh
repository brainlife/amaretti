#script used by travis to setup testing environment
#invoked via .travis.yml

if [ -f config/index.js ]; then
    echo "config/index.js already exists.. skipping config installation"
    exit
fi

cp test/config/* config/

#if [ ! -f config/auth.key ];
#then
#    echo "installing test auth.key /.pub"
#    (
#    cp test/config/auth.key config/auth.key
#    cp test/config/auth.pub config/auth.pub
#    )
#fi
#
#if [ ! -f config/index.js ];
#then
#    echo "installing test config/index.js"
#    cp test/config/index.js config/index.js 
#fi
#
#if [ ! -f config/resources.js ];
#then
#    echo "installing test config/resources.js"
#    cp test/config/resources.js config/resources.js 
#fi


