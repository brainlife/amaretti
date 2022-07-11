#!/bin/bash

docker-compose exec auth /apps/auth/bin/auth.js \
    issue \
    --scopes '{ "auth": ["admin"], "amaretti": ["admin"] }' \
    --sub 'amaretti' \
    --out /apps/amaretti/api/config/amaretti.jwt
