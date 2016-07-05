
#to be used to issue 2ndary jwt token from sca-auth
~/git/auth/bin/auth.js issue --scopes '{ "sca": ["admin"] }' --sub 'sca' --out sca.jwt
