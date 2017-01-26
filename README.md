[![Build Status](https://travis-ci.org/soichih/sca-wf.svg?branch=master)](https://travis-ci.org/soichih/sca-wf)
[![Coverage Status](https://coveralls.io/repos/github/soichih/sca-wf/badge.svg?branch=master)](https://coveralls.io/github/soichih/sca-wf?branch=master)

# SCA Workflow Service

This service handles data transfer / execution of *tasks* requested by users through the API.

A part of this service complies with [ABCD Specification](https://github.com/soichih/abcd-spec).

## TODO

* Make sure hsi command is installed
* Check for tasks that are stuck on the same status (like RUNNING for good..) and notify SCA admins (probably shouldn't change the task status, however)
* Put user_id checks back on sca-task (need to handle gids)
* It is possible to initialize dependent services while dependnecies are still running?
* sync jobs can't be stopped.. or resumed in case of error? also, should it raise warning if it runs more than few minutes?
* Let user set timeout for a task - if task is running longer than expected, mark as failed - rather than keep checking (or.. maybe we should reduce the frequency of the status check?)
* for raw file viewer, display content of text file if the file size is small and all ascii in pre tag
* On auth service, let user issue long living (non-expiring?) jwt token to be used for command line / api access?
* Allow user to download entire taskdir.
* Instead of storing private key on dest(or src?) resource for rsync, can I use agent forwarding?
* I should probably test each ssh sessions opened, or timeout eventually if not used for a long time?
* Implement task re-try strategy (just keep retrying - wait for resource?)
* I should switch to use test mongo db to run mocha locally - instead of using the test db.. so that I can recreate exact same test output on travis
