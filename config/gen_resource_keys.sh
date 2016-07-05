
#I don't remember what this was used for.

#~/git/auth/bin/auth.js issue --scopes '{"sca":[] }' --sub 'sca' --out progress.jwt 
openssl genrsa -out resource.private.pem 2048 && chmod 600 resource.private.pem
openssl rsa -in resource.private.pem -pubout -out resource.public.pem
