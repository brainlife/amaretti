
# SCA Workflow Service


* sca-task

Handles tasks.

Status:

requested: requested by the user (_handled will be set for requested that's taken by sca-task for incomplete mutex)
running: task is running on a resource (sca-task will periodically poll status)
running_sync: task is running on a resource - synchrnously
failed: task has failed
finished: tash has finished successfully

* TODO

Check for tasks that are stuck on the same status (like RUNNING for good..) and notify SCA admins (probably shouldn't change the task status, however)

Put user_id checks back on sca-task (need to handle gids)

It is possible to initialize dependent services while dependnecies are still running?

sync jobs can't be stopped.. or resumed in case of error? also, should it raise warning if it runs more than few minutes?
