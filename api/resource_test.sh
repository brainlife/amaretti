#!/bin/bash

#This script will be copied to each resource everytime resource checker test resource status and used to test the resource

#terminate if any command fails (and any command piped)
set -e
set -o pipefail

#whoami

#check for common binaries
which git
which jq
#which singulalrity #TODO - not all resource needs singularity.. but should I make it mandetary?

#check for default abcd hook
which start
which stop
which status

#check for access right
mkdir _resource_check && rmdir _resource_check

