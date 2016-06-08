define({ "api": [
  {
    "type": "get",
    "url": "/resource",
    "title": "Get resource registrations",
    "parameter": {
      "fields": {
        "Parameter": [
          {
            "group": "Parameter",
            "type": "Object",
            "optional": false,
            "field": "where",
            "description": "<p>Optional Mongo query to perform</p>"
          }
        ]
      }
    },
    "description": "<p>Returns all resource registration detail that belongs to a user</p>",
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
    "type": "post",
    "url": "/resource",
    "title": "Register new resource",
    "name": "NewResource",
    "group": "Resource",
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
          "content": "HTTP/1.1 200 OK\n{\n    \"status\": \"ok\"\n}",
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
    "url": "/resource/test/:resource_id",
    "title": "Test resource",
    "name": "TestResource",
    "group": "Resource",
    "parameter": {
      "fields": {
        "Parameter": [
          {
            "group": "Parameter",
            "type": "String",
            "optional": false,
            "field": "resource_id",
            "description": "<p>Resource ID</p>"
          }
        ]
      }
    },
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
    "type": "get",
    "url": "/service",
    "title": "GetService",
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
    "title": "NewService",
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
    "type": "post",
    "url": "/task",
    "title": "NewTask",
    "group": "Task",
    "description": "<p>Submit a task under a workflow instance</p>",
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
  }
] });
