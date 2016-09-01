echo "generating admin.jwt"
~/git/auth/bin/auth.js issue --scopes '{ "sca": ["user", "admin"] }' --sub 'sca' --out admin.jwt 

echo "generting wf.key/wf.pub"
openssl genrsa -out wf.key 2048
openssl rsa -in wf.key -pubout > wf.pub
