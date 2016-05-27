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
    "url": "/",
    "title": "Register new SCA service",
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
    "name": "Post"
  }
] });
