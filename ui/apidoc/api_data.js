define({ "api": [
  {
    "type": "get",
    "url": "/instance",
    "title": "Query Instance",
    "group": "Instance",
    "description": "<p>Query instances that belongs to a user with given query</p>",
    "parameter": {
      "fields": {
        "Parameter": [
          {
            "group": "Parameter",
            "type": "Object",
            "optional": true,
            "field": "find",
            "description": "<p>Mongo find query JSON.stringify &amp; encodeURIComponent-ed - defaults to {}</p>"
          },
          {
            "group": "Parameter",
            "type": "Object",
            "optional": true,
            "field": "sort",
            "description": "<p>Mongo sort object - defaults to _id. Enter in string format like &quot;-name%20desc&quot;</p>"
          },
          {
            "group": "Parameter",
            "type": "String",
            "optional": true,
            "field": "select",
            "description": "<p>Fields to load - defaults to 'logical_id'. Multiple fields can be entered with %20 as delimiter</p>"
          },
          {
            "group": "Parameter",
            "type": "Number",
            "optional": true,
            "field": "limit",
            "description": "<p>Maximum number of records to return - defaults to 100</p>"
          },
          {
            "group": "Parameter",
            "type": "Number",
            "optional": true,
            "field": "skip",
            "description": "<p>Record offset for pagination (default to 0)</p>"
          }
        ]
      }
    },
    "header": {
      "fields": {
        "Header": [
          {
            "group": "Header",
            "type": "String",
            "optional": false,
            "field": "Authorization",
            "description": "<p>A valid JWT token &quot;Bearer: xxxxx&quot;</p>"
          }
        ]
      }
    },
    "success": {
      "fields": {
        "Success 200": [
          {
            "group": "Success 200",
            "type": "Object",
            "optional": false,
            "field": "List",
            "description": "<p>of instances (maybe limited / skipped) and total number of instances</p>"
          }
        ]
      }
    },
    "version": "0.0.0",
    "filename": "api/controllers/instance.js",
    "groupTitle": "Instance",
    "name": "GetInstance"
  },
  {
    "type": "post",
    "url": "/instance",
    "title": "New Instance",
    "group": "Instance",
    "description": "<p>Create a new instance</p>",
    "parameter": {
      "fields": {
        "Parameter": [
          {
            "group": "Parameter",
            "type": "String",
            "optional": false,
            "field": "workflow_id",
            "description": "<p>Name of workflow that this instance belongs to (sca-wf-life)</p>"
          },
          {
            "group": "Parameter",
            "type": "String",
            "optional": false,
            "field": "name",
            "description": "<p>Name of the instance</p>"
          },
          {
            "group": "Parameter",
            "type": "String",
            "optional": true,
            "field": "desc",
            "description": "<p>Description of the instance</p>"
          },
          {
            "group": "Parameter",
            "type": "Object",
            "optional": true,
            "field": "config",
            "description": "<p>Any information you'd like to associate with this instanace</p>"
          }
        ]
      }
    },
    "header": {
      "fields": {
        "Header": [
          {
            "group": "Header",
            "type": "String",
            "optional": false,
            "field": "Authorization",
            "description": "<p>A valid JWT token &quot;Bearer: xxxxx&quot;</p>"
          }
        ]
      }
    },
    "version": "0.0.0",
    "filename": "api/controllers/instance.js",
    "groupTitle": "Instance",
    "name": "PostInstance"
  },
  {
    "type": "put",
    "url": "/instance/:instid",
    "title": "Update Instance",
    "group": "Instance",
    "description": "<p>Update Instance</p>",
    "parameter": {
      "fields": {
        "Parameter": [
          {
            "group": "Parameter",
            "type": "String",
            "optional": true,
            "field": "name",
            "description": "<p>Name for this instance</p>"
          },
          {
            "group": "Parameter",
            "type": "String",
            "optional": true,
            "field": "desc",
            "description": "<p>Description for this instance</p>"
          },
          {
            "group": "Parameter",
            "type": "Object",
            "optional": true,
            "field": "config",
            "description": "<p>Configuration for this instance</p>"
          }
        ]
      }
    },
    "header": {
      "fields": {
        "Header": [
          {
            "group": "Header",
            "type": "String",
            "optional": false,
            "field": "authorization",
            "description": "<p>A valid JWT token &quot;Bearer: xxxxx&quot;</p>"
          }
        ]
      }
    },
    "version": "0.0.0",
    "filename": "api/controllers/instance.js",
    "groupTitle": "Instance",
    "name": "PutInstanceInstid"
  },
  {
    "type": "get",
    "url": "/resource/gensshkey",
    "title": "Generate ssh key pair",
    "name": "GENSSHKEYResource",
    "group": "Resource",
    "description": "<p>used by resource editor to setup new resource jwt is optional.. since it doesn't really store this anywhere (should I?) kdinstaller uses this to generate key (and scott's snapshot tool)</p> <p>//@apiHeader {String} [authorization] A valid JWT token &quot;Bearer: xxxxx&quot;</p>",
    "success": {
      "examples": [
        {
          "title": "Success-Response:",
          "content": "HTTP/1.1 200 OK\n{ pubkey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDDxtMlosV+/5CutlW3YIO4ZomH6S0+3VmDlAAYvBXHD+ut4faGAZ4XuumfJyg6EAu8TbUo+Qj6+pLuYLcjqxl2fzI6om2SFh9UeXkm1P0flmgHrmXnUJNnsnyen/knJtWltwDAZZOLj0VcfkPaJX7sOSp9l/8W1+7Qb05jl+lzNKucpe4qInh+gBymcgZtMudtmurEuqt2eVV7W067xJ7P30PAZhZa7OwXcQrqcbVlA1V7yk1V92O7Qt8QTlLCbszE/xx0cTEBiSkmkvEG2ztQQl2Uqi+lAIEm389quVPJqjDEzaMipZ1X5xgfnyDtBq0t/SUGZ8d0Ki1H0jmU7H//',\n  key: '-----BEGIN RSA PRIVATE KEY-----\\nMIIEogIBAAKCAQEAw8 ... CeSZ6sKiQmE46Yh4/zyRD4JgW4CY=\\n-----END RSA PRIVATE KEY-----' }",
          "type": "json"
        }
      ]
    },
    "version": "0.0.0",
    "filename": "api/controllers/resource.js",
    "groupTitle": "Resource"
  },
  {
    "type": "get",
    "url": "/resource",
    "title": "Query resource registrations",
    "parameter": {
      "fields": {
        "Parameter": [
          {
            "group": "Parameter",
            "type": "Object",
            "optional": false,
            "field": "find",
            "description": "<p>Optional Mongo query to perform</p>"
          }
        ]
      }
    },
    "description": "<p>Returns all resource registration detail that belongs to a user (doesn't include resource with group access)</p>",
    "group": "Resource",
    "header": {
      "fields": {
        "Header": [
          {
            "group": "Header",
            "type": "String",
            "optional": false,
            "field": "authorization",
            "description": "<p>A valid JWT token &quot;Bearer: xxxxx&quot;</p>"
          }
        ]
      }
    },
    "success": {
      "fields": {
        "Success 200": [
          {
            "group": "Success 200",
            "type": "Object[]",
            "optional": false,
            "field": "resources",
            "description": "<p>Resource detail</p>"
          }
        ]
      }
    },
    "version": "0.0.0",
    "filename": "api/controllers/resource.js",
    "groupTitle": "Resource",
    "name": "GetResource"
  },
  {
    "type": "get",
    "url": "/resource/download",
    "title": "Download file from resource",
    "parameter": {
      "fields": {
        "Parameter": [
          {
            "group": "Parameter",
            "type": "String",
            "optional": false,
            "field": "r",
            "description": "<p>Resource ID</p>"
          },
          {
            "group": "Parameter",
            "type": "String",
            "optional": false,
            "field": "p",
            "description": "<p>File path to download (relative to work directory - parent of all instance dir)</p>"
          },
          {
            "group": "Parameter",
            "type": "String",
            "optional": true,
            "field": "at",
            "description": "<p>JWT token - if user can't provide it via authentication header</p>"
          }
        ]
      }
    },
    "description": "<p>Allows user to download any files from user's resource</p>",
    "group": "Resource",
    "header": {
      "fields": {
        "Header": [
          {
            "group": "Header",
            "type": "String",
            "optional": true,
            "field": "authorization",
            "description": "<p>A valid JWT token &quot;Bearer: xxxxx&quot;</p>"
          }
        ]
      }
    },
    "version": "0.0.0",
    "filename": "api/controllers/resource.js",
    "groupTitle": "Resource",
    "name": "GetResourceDownload"
  },
  {
    "type": "get",
    "url": "/resource/ls/:resource_id",
    "title": "List directory",
    "group": "Resource",
    "description": "<p>Get directory listing on a resource on specified path</p>",
    "parameter": {
      "fields": {
        "Parameter": [
          {
            "group": "Parameter",
            "type": "String",
            "optional": false,
            "field": "path",
            "description": "<p>Path to load directory (relative to workdir)</p>"
          }
        ]
      }
    },
    "header": {
      "fields": {
        "Header": [
          {
            "group": "Header",
            "type": "String",
            "optional": false,
            "field": "Authorization",
            "description": "<p>A valid JWT token &quot;Bearer: xxxxx&quot;</p>"
          }
        ]
      }
    },
    "success": {
      "examples": [
        {
          "title": "Success-Response:",
          "content": "{\"files\":[\n    {   \n        \"filename\":\"config.json\",\n        \"attrs\": {\n            \"mode\":33188,\n            \"mode_string\":\"-rw-r--r--\",\n            \"uid\":1170473,\n            \"owner\": \"hayashis\",\n            \"gid\":4160,\n            \"group\": \"hpss\",\n            \"size\":117,\n            \"atime\":1466517617,\n            \"mtime\":1466517617\n        },\n        \"_raw\":\"-rw-r--r--    1 odidev   odi           117 Jun 21 10:00 config.json\"\n    }\n]}",
          "type": "json"
        }
      ]
    },
    "version": "0.0.0",
    "filename": "api/controllers/resource.js",
    "groupTitle": "Resource",
    "name": "GetResourceLsResource_id"
  },
  {
    "type": "post",
    "url": "/resource",
    "title": "Register new resource instance",
    "name": "NewResource",
    "group": "Resource",
    "parameter": {
      "fields": {
        "Parameter": [
          {
            "group": "Parameter",
            "type": "String",
            "optional": false,
            "field": "type",
            "description": "<p>&quot;hpss&quot;, or &quot;ssh&quot; for now</p>"
          },
          {
            "group": "Parameter",
            "type": "String",
            "optional": false,
            "field": "resource_id",
            "description": "<p>ID of this resource instance (&quot;karst&quot;, &quot;mason&quot;, etc..)</p>"
          },
          {
            "group": "Parameter",
            "type": "String",
            "optional": false,
            "field": "name",
            "description": "<p>Name of this resource instance (like &quot;soichi's karst account&quot;)</p>"
          },
          {
            "group": "Parameter",
            "type": "Object",
            "optional": false,
            "field": "config",
            "description": "<p>Configuration for resource</p>"
          },
          {
            "group": "Parameter",
            "type": "Boolean",
            "optional": false,
            "field": "active",
            "description": "<p>Set true to enable resource</p>"
          },
          {
            "group": "Parameter",
            "type": "Number[]",
            "optional": true,
            "field": "gids",
            "description": "<p>List of groups that can use this resource</p>"
          },
          {
            "group": "Parameter",
            "type": "Object",
            "optional": true,
            "field": "envs",
            "description": "<p>Key values to be inserted for service execution</p>"
          }
        ]
      }
    },
    "description": "<p>Just create a DB entry for a new resource - it doesn't test resource / install keys, etc..</p>",
    "header": {
      "fields": {
        "Header": [
          {
            "group": "Header",
            "type": "String",
            "optional": false,
            "field": "authorization",
            "description": "<p>A valid JWT token &quot;Bearer: xxxxx&quot;</p>"
          }
        ]
      }
    },
    "success": {
      "examples": [
        {
          "title": "Success-Response:",
          "content": "HTTP/1.1 200 OK\n{ __v: 0,\n user_id: '9',\n gids: [1,2,3],\n type: 'ssh',\n resource_id: 'karst',\n name: 'use foo\\'s karst account',\n config: \n  { ssh_public: 'my public key',\n    enc_ssh_private: true,\n    username: 'hayashis' },\n _id: '5758759710168abc3562bf01',\n update_date: '2016-06-08T19:44:23.205Z',\n create_date: '2016-06-08T19:44:23.204Z',\n active: true }",
          "type": "json"
        }
      ]
    },
    "version": "0.0.0",
    "filename": "api/controllers/resource.js",
    "groupTitle": "Resource"
  },
  {
    "type": "delete",
    "url": "/resource/:id",
    "title": "Remove resource",
    "name": "RemoveResource",
    "group": "Resource",
    "parameter": {
      "fields": {
        "Parameter": [
          {
            "group": "Parameter",
            "type": "String",
            "optional": false,
            "field": "id",
            "description": "<p>Resource ID</p>"
          }
        ]
      }
    },
    "description": "<p>Remove resource instance</p>",
    "header": {
      "fields": {
        "Header": [
          {
            "group": "Header",
            "type": "String",
            "optional": false,
            "field": "authorization",
            "description": "<p>A valid JWT token &quot;Bearer: xxxxx&quot;</p>"
          }
        ]
      }
    },
    "success": {
      "fields": {
        "Success 200": [
          {
            "group": "Success 200",
            "type": "String",
            "optional": false,
            "field": "ok",
            "description": ""
          }
        ]
      }
    },
    "version": "0.0.0",
    "filename": "api/controllers/resource.js",
    "groupTitle": "Resource"
  },
  {
    "type": "put",
    "url": "/resource/test/:resource_id",
    "title": "Test resource",
    "name": "TestResource",
    "group": "Resource",
    "description": "<p>Test resource connectivity and availability. Store status on status/status_msg fields of the resource entry</p>",
    "header": {
      "fields": {
        "Header": [
          {
            "group": "Header",
            "type": "String",
            "optional": false,
            "field": "authorization",
            "description": "<p>A valid JWT token &quot;Bearer: xxxxx&quot;</p>"
          }
        ]
      }
    },
    "success": {
      "examples": [
        {
          "title": "Success-Response:",
          "content": "HTTP/1.1 200 OK\n{\n    \"status\": \"ok\"\n}",
          "type": "json"
        }
      ]
    },
    "error": {
      "examples": [
        {
          "title": "Error-Response:",
          "content": "HTTP/1.1 500 OK\n{\n    \"message\": \"SSH connection failed\"\n}",
          "type": "json"
        }
      ]
    },
    "version": "0.0.0",
    "filename": "api/controllers/resource.js",
    "groupTitle": "Resource"
  },
  {
    "type": "put",
    "url": "/resource/:id",
    "title": "Update resource instance configuration",
    "name": "UpdateResource",
    "group": "Resource",
    "parameter": {
      "fields": {
        "Parameter": [
          {
            "group": "Parameter",
            "type": "String",
            "optional": false,
            "field": "id",
            "description": "<p>Resource Instance ID to update</p>"
          },
          {
            "group": "Parameter",
            "type": "Object",
            "optional": true,
            "field": "config",
            "description": "<p>Resource Configuration to update</p>"
          },
          {
            "group": "Parameter",
            "type": "Object",
            "optional": true,
            "field": "envs",
            "description": "<p>Resource environment parameters to update</p>"
          },
          {
            "group": "Parameter",
            "type": "String",
            "optional": true,
            "field": "name",
            "description": "<p>Name of this resource instance</p>"
          },
          {
            "group": "Parameter",
            "type": "Number[]",
            "optional": true,
            "field": "gids",
            "description": "<p>List of groups that can use this resource</p>"
          },
          {
            "group": "Parameter",
            "type": "Boolean",
            "optional": true,
            "field": "active",
            "description": "<p>Set true to enable resource</p>"
          }
        ]
      }
    },
    "description": "<p>Update the resource instance (only the resource that user owns)</p>",
    "header": {
      "fields": {
        "Header": [
          {
            "group": "Header",
            "type": "String",
            "optional": false,
            "field": "authorization",
            "description": "<p>A valid JWT token &quot;Bearer: xxxxx&quot;</p>"
          }
        ]
      }
    },
    "success": {
      "fields": {
        "Success 200": [
          {
            "group": "Success 200",
            "type": "Object",
            "optional": false,
            "field": "Resource",
            "description": "<p>Object</p>"
          }
        ]
      }
    },
    "version": "0.0.0",
    "filename": "api/controllers/resource.js",
    "groupTitle": "Resource"
  },
  {
    "type": "get",
    "url": "/service",
    "title": "Query Services",
    "group": "Service",
    "description": "<p>Query for SCA services</p>",
    "parameter": {
      "fields": {
        "Parameter": [
          {
            "group": "Parameter",
            "type": "Object",
            "optional": true,
            "field": "find",
            "description": "<p>Mongo find query - defaults to {}</p>"
          },
          {
            "group": "Parameter",
            "type": "Object",
            "optional": true,
            "field": "sort",
            "description": "<p>Mongo sort object - defaults to {}</p>"
          },
          {
            "group": "Parameter",
            "type": "String",
            "optional": true,
            "field": "select",
            "description": "<p>Fields to load - defaults to 'logical_id'</p>"
          },
          {
            "group": "Parameter",
            "type": "Number",
            "optional": true,
            "field": "limit",
            "description": "<p>Maximum number of records to return - defaults to 100</p>"
          },
          {
            "group": "Parameter",
            "type": "Number",
            "optional": true,
            "field": "skip",
            "description": "<p>Record offset for pagination</p>"
          }
        ]
      }
    },
    "header": {
      "fields": {
        "Header": [
          {
            "group": "Header",
            "type": "String",
            "optional": false,
            "field": "Authorization",
            "description": "<p>A valid JWT token &quot;Bearer: xxxxx&quot;</p>"
          }
        ]
      }
    },
    "success": {
      "fields": {
        "Success 200": [
          {
            "group": "Success 200",
            "type": "Object[]",
            "optional": false,
            "field": "Services",
            "description": "<p>Service detail</p>"
          }
        ]
      }
    },
    "version": "0.0.0",
    "filename": "api/controllers/service.js",
    "groupTitle": "Service",
    "name": "GetService"
  },
  {
    "type": "post",
    "url": "/service",
    "title": "New Service",
    "parameter": {
      "fields": {
        "Parameter": [
          {
            "group": "Parameter",
            "type": "String",
            "optional": false,
            "field": "giturl",
            "description": "<p>Github URL to register service (like https://github.com/soichih/sca-service-life)</p>"
          }
        ]
      }
    },
    "description": "<p>From specified Github URL, this API will register new service using github repo info and package.json</p>",
    "group": "Service",
    "header": {
      "fields": {
        "Header": [
          {
            "group": "Header",
            "type": "String",
            "optional": false,
            "field": "authorization",
            "description": "<p>A valid JWT token &quot;Bearer: xxxxx&quot;</p>"
          }
        ]
      }
    },
    "success": {
      "examples": [
        {
          "title": "Success-Response:",
          "content": "HTTP/1.1 200 OK\n{\n    \"__v\": 0,\n    \"user_id\": \"1\",\n    \"name\": \"soichih/sca-service-life\",\n    \"git\": {...},\n    \"pkg\": {...},\n    \"register_date\": \"2016-05-26T14:14:51.526Z\"\n}",
          "type": "json"
        }
      ]
    },
    "error": {
      "examples": [
        {
          "title": "Error-Response:",
          "content": "HTTP/1.1 500 OK\n{\n    \"code\": 11000,\n    \"index\": 0,\n    \"errmsg\": \"insertDocument :: caused by :: 11000 E11000 duplicate key error index: sca.services.$name_1  dup key: { : \\\"soichih/sca-service-life\\\" }\",\n    ...\n}",
          "type": "json"
        }
      ]
    },
    "version": "0.0.0",
    "filename": "api/controllers/service.js",
    "groupTitle": "Service",
    "name": "PostService"
  },
  {
    "type": "get",
    "url": "/health",
    "title": "Get API status",
    "description": "<p>Get current API status</p>",
    "name": "GetHealth",
    "group": "System",
    "success": {
      "fields": {
        "Success 200": [
          {
            "group": "Success 200",
            "type": "String",
            "optional": false,
            "field": "status",
            "description": "<p>'ok' or 'failed'</p>"
          }
        ]
      }
    },
    "version": "0.0.0",
    "filename": "api/controllers/index.js",
    "groupTitle": "System"
  },
  {
    "type": "delete",
    "url": "/task/:taskid",
    "title": "DEPRECATED: Remove a task",
    "group": "Task",
    "description": "<p>Physically remove a task from DB. Tasks that depends on deleted task will not be removed but will point to now missing task. Which may or may not fail.</p>",
    "header": {
      "fields": {
        "Header": [
          {
            "group": "Header",
            "type": "String",
            "optional": false,
            "field": "authorization",
            "description": "<p>A valid JWT token &quot;Bearer: xxxxx&quot;</p>"
          }
        ]
      }
    },
    "success": {
      "examples": [
        {
          "title": "Success-Response:",
          "content": "HTTP/1.1 200 OK\n{\n    \"message\": \"Task successfully removed\",\n}",
          "type": "json"
        }
      ]
    },
    "version": "0.0.0",
    "filename": "api/controllers/task.js",
    "groupTitle": "Task",
    "name": "DeleteTaskTaskid"
  },
  {
    "type": "get",
    "url": "/task",
    "title": "Query Tasks",
    "parameter": {
      "fields": {
        "Parameter": [
          {
            "group": "Parameter",
            "type": "Object",
            "optional": false,
            "field": "find",
            "description": "<p>Optional Mongo query to perform</p>"
          }
        ]
      }
    },
    "description": "<p>Returns all tasks that belongs to a user</p>",
    "group": "Task",
    "header": {
      "fields": {
        "Header": [
          {
            "group": "Header",
            "type": "String",
            "optional": false,
            "field": "authorization",
            "description": "<p>A valid JWT token &quot;Bearer: xxxxx&quot;</p>"
          }
        ]
      }
    },
    "success": {
      "fields": {
        "Success 200": [
          {
            "group": "Success 200",
            "type": "Object[]",
            "optional": false,
            "field": "tasks",
            "description": "<p>Task detail</p>"
          }
        ]
      }
    },
    "version": "0.0.0",
    "filename": "api/controllers/task.js",
    "groupTitle": "Task",
    "name": "GetTask"
  },
  {
    "type": "post",
    "url": "/task",
    "title": "New Task",
    "group": "Task",
    "description": "<p>Submit a task under a workflow instance</p>",
    "parameter": {
      "fields": {
        "Parameter": [
          {
            "group": "Parameter",
            "type": "String",
            "optional": false,
            "field": "instance_id",
            "description": "<p>Instance ID to submit this task</p>"
          },
          {
            "group": "Parameter",
            "type": "String",
            "optional": false,
            "field": "service",
            "description": "<p>Name of the service to run</p>"
          },
          {
            "group": "Parameter",
            "type": "String",
            "optional": true,
            "field": "name",
            "description": "<p>Name for this task</p>"
          },
          {
            "group": "Parameter",
            "type": "String",
            "optional": true,
            "field": "desc",
            "description": "<p>Description for this task</p>"
          },
          {
            "group": "Parameter",
            "type": "String",
            "optional": true,
            "field": "preferred_resource_id",
            "description": "<p>resource that user prefers to run this service on (may or may not be chosen)</p>"
          },
          {
            "group": "Parameter",
            "type": "Object",
            "optional": true,
            "field": "config",
            "description": "<p>Configuration to pass to the service (will be stored as config.json in task dir)</p>"
          },
          {
            "group": "Parameter",
            "type": "String[]",
            "optional": true,
            "field": "deps",
            "description": "<p>task IDs that this serivce depends on. This task will be executed as soon as all dependency tasks are completed.</p>"
          },
          {
            "group": "Parameter",
            "type": "String[]",
            "optional": true,
            "field": "resource_deps",
            "description": "<p>List of resource_ids where the access credential to be installed on ~/.sca/keys to allow access to the specified resource</p>"
          }
        ]
      }
    },
    "header": {
      "fields": {
        "Header": [
          {
            "group": "Header",
            "type": "String",
            "optional": false,
            "field": "authorization",
            "description": "<p>A valid JWT token &quot;Bearer: xxxxx&quot;</p>"
          }
        ]
      }
    },
    "success": {
      "examples": [
        {
          "title": "Success-Response:",
          "content": "HTTP/1.1 200 OK\n{\n    \"message\": \"Task successfully registered\",\n    \"task\": {},\n}",
          "type": "json"
        }
      ]
    },
    "version": "0.0.0",
    "filename": "api/controllers/task.js",
    "groupTitle": "Task",
    "name": "PostTask"
  },
  {
    "type": "put",
    "url": "/task/rerun/:taskid",
    "title": "Rerun finished / failed task",
    "group": "Task",
    "description": "<p>Reset the task status to &quot;requested&quot; and reset products / next_date</p>",
    "header": {
      "fields": {
        "Header": [
          {
            "group": "Header",
            "type": "String",
            "optional": false,
            "field": "authorization",
            "description": "<p>A valid JWT token &quot;Bearer: xxxxx&quot;</p>"
          }
        ]
      }
    },
    "success": {
      "examples": [
        {
          "title": "Success-Response:",
          "content": "HTTP/1.1 200 OK\n{\n    \"message\": \"Task successfully re-requested\",\n    \"task\": {},\n}",
          "type": "json"
        }
      ]
    },
    "version": "0.0.0",
    "filename": "api/controllers/task.js",
    "groupTitle": "Task",
    "name": "PutTaskRerunTaskid"
  },
  {
    "type": "put",
    "url": "/task/stop/:taskid",
    "title": "Request task to be stopped",
    "group": "Task",
    "description": "<p>Set the status to &quot;stop_requested&quot; if running.</p>",
    "header": {
      "fields": {
        "Header": [
          {
            "group": "Header",
            "type": "String",
            "optional": false,
            "field": "authorization",
            "description": "<p>A valid JWT token &quot;Bearer: xxxxx&quot;</p>"
          }
        ]
      }
    },
    "success": {
      "examples": [
        {
          "title": "Success-Response:",
          "content": "HTTP/1.1 200 OK\n{\n    \"message\": \"Task successfully requested to stop\",\n    \"task\": {},\n}",
          "type": "json"
        }
      ]
    },
    "version": "0.0.0",
    "filename": "api/controllers/task.js",
    "groupTitle": "Task",
    "name": "PutTaskStopTaskid"
  },
  {
    "type": "put",
    "url": "/task/:taskid",
    "title": "Update Task",
    "group": "Task",
    "description": "<p>(Admin only) This API allows you to update task detail. Normally, you don't really want to update task detail after it's submitted. Doing so might cause task to become inconsistent with the actual state. To remove a field, set the field to null (not undefined - since it's not valid JSON)</p>",
    "parameter": {
      "fields": {
        "Parameter": [
          {
            "group": "Parameter",
            "type": "String",
            "optional": true,
            "field": "name",
            "description": "<p>Name for this task</p>"
          },
          {
            "group": "Parameter",
            "type": "String",
            "optional": true,
            "field": "desc",
            "description": "<p>Description for this task</p>"
          },
          {
            "group": "Parameter",
            "type": "String",
            "optional": true,
            "field": "service",
            "description": "<p>Name of the service to run</p>"
          },
          {
            "group": "Parameter",
            "type": "String",
            "optional": true,
            "field": "preferred_resource_id",
            "description": "<p>resource that user prefers to run this service on (may or may not be chosen)</p>"
          },
          {
            "group": "Parameter",
            "type": "Object",
            "optional": true,
            "field": "config",
            "description": "<p>Configuration to pass to the service (will be stored as config.json in task dir)</p>"
          },
          {
            "group": "Parameter",
            "type": "String[]",
            "optional": true,
            "field": "deps",
            "description": "<p>task IDs that this serivce depends on. This task will be executed as soon as all dependency tasks are completed.</p>"
          },
          {
            "group": "Parameter",
            "type": "String[]",
            "optional": true,
            "field": "resource_deps",
            "description": "<p>List of resource_ids where the access credential to be installed on ~/.sca/keys to allow access to the specified resource</p>"
          },
          {
            "group": "Parameter",
            "type": "Object",
            "optional": true,
            "field": "products",
            "description": "<p>Products generated by this task</p>"
          },
          {
            "group": "Parameter",
            "type": "String",
            "optional": true,
            "field": "status",
            "description": "<p>Status of the task</p>"
          },
          {
            "group": "Parameter",
            "type": "String",
            "optional": true,
            "field": "status_msg",
            "description": "<p>Status message</p>"
          }
        ]
      }
    },
    "header": {
      "fields": {
        "Header": [
          {
            "group": "Header",
            "type": "String",
            "optional": false,
            "field": "authorization",
            "description": "<p>A valid JWT token &quot;Bearer: xxxxx&quot;</p>"
          }
        ]
      }
    },
    "version": "0.0.0",
    "filename": "api/controllers/task.js",
    "groupTitle": "Task",
    "name": "PutTaskTaskid"
  }
] });
