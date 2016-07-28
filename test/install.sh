#script used by travis to setup testing environment
#invoked via .travis.yml

if [ -f config/index.js ]; then
    echo "config/index.js already exists.. skipping config installation"
    exit
fi

echo "installing test configuration"
cp test/config/* config/

