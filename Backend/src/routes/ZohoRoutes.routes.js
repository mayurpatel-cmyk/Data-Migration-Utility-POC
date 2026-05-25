const express = require('express');
const router = express.Router();
const zohoController = require('../controllers/zohoController');
// 1. Get all visible modules in Zoho CRM
router.get('/modules', zohoController.getAllModules);
// 2. Get fields for a specific module
router.get('/modules/:moduleName/fields', zohoController.getModuleFields);
module.exports = router;