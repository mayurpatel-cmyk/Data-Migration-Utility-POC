const express = require('express');
const router = express.Router();
const validationController = require('../controllers/validation.controller');
const requireSalesforceAuth = require('../middlewares/auth.middleware');

// POST /api/validate-data
router.post('/', requireSalesforceAuth, validationController.validateData);

module.exports = router;