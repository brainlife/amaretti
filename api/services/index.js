'use strict';

//contrib
var express = require('express');
var router = express.Router();
var jwt = require('express-jwt');
var _ = require('underscore');

//mine
var config = require('../config');

router.use('/hpss', require('./hpss'));
router.use('/upload', require('./upload'));

module.exports = router;

