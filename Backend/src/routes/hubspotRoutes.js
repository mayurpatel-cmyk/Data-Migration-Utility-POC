const express = require('express');
const router = express.Router();
const hubspotController = require('../controllers/hubspotController');

router.get('/objects', hubspotController.getAllObjects);

router.get('/objects/:objectName/fields', hubspotController.getObjectFields);

router.get('/user-info', hubspotController.getUserInfo);

module.exports = router;
