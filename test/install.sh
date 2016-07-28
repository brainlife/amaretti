#script used by travis to setup testing environment
#invoked via .travis.yml

if [ -f config/index.js ]; then
    echo "config/index.js already exists.. skipping config installation"
    exit
fi

echo "installing test configuration"
cp test/config/* config/

echo "admin.jwt"
cat config/admin.jwt 

echo "auth.pub"
cat config/auth.pub

echo "auth.key"
cat config/auth.key
