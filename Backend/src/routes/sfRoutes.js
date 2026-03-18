const express = require('express');
const router = express.Router();
const sfController = require('../controllers/sfController');
const requireSalesforceAuth = require('../middlewares/auth.middleware');

// Get list of standard objects
router.get('/standard-objects',requireSalesforceAuth,  sfController.getStandardObjects);

// Get fields for a specific object (e.g. /api/sf/fields/Account)
router.get('/fields/:objectName',requireSalesforceAuth,  sfController.getObjectFields);

module.exports = router;