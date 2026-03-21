const express = require('express');
const router = express.Router();
const migrationController = require('../controllers/migration.controller');
const requireSalesforceAuth = require('../middlewares/auth.middleware');

router.post('/migrate-data', requireSalesforceAuth, migrationController.migrateData);

module.exports = router;