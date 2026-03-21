const express = require('express');
const router = express.Router();
const sfController = require('../controllers/sfController');

const requireSalesforceAuth = require('../middlewares/auth.middleware');

// 1. UPDATED THIS LINE: Changed URL to /all-objects and function to sfController.getAllObjects
router.get('/all-objects', requireSalesforceAuth, sfController.getAllObjects);

// Get fields for a specific object (e.g. /api/sf/fields/Account)
router.get('/fields/:objectName', requireSalesforceAuth, sfController.getObjectFields);

router.get('/user-info', requireSalesforceAuth, sfController.getUserDetails);

module.exports = router;