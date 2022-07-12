#!/bin/bash

if [ ! -f /apps/amaretti/api/config/amaretti.jwt ]; then
    /apps/auth/bin/auth.js \
        issue \
        --scopes '{ "auth": ["admin"], "amaretti": ["admin"] }' \
        --sub 'amaretti' \
        --out /apps/amaretti/api/config/amaretti.jwt
fi
