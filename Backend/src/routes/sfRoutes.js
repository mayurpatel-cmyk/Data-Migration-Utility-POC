const express = require('express');
const router = express.Router();
const sfController = require('../controllers/sfController');

const requireSalesforceAuth = require('../middlewares/auth.middleware');

router.get('/all-objects', requireSalesforceAuth, sfController.getAllObjects);

router.get('/fields/:objectName', requireSalesforceAuth, sfController.getObjectFields);

router.get('/user-info', requireSalesforceAuth, sfController.getUserDetails);

module.exports = router;