const express = require('express');
const authController = require('../controllers/auth.controller');

const router = express.Router();

// POST /api/auth/login
router.post('/login', authController.login);
router.get('/callback', authController.callback); // Handle Salesforce callback
// Append directly inside src/routes/auth.routes.js
router.post('/zoho-login', authController.zohoLogin);
router.get('/zoho-callback', authController.zohoCallback);

// HubSpot OAuth routes
router.post('/hubspot-login', authController.hubspotLogin);
router.get('/hubspot-callback', authController.hubspotCallback);

module.exports = router;