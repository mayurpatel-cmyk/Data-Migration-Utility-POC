const express = require('express');
const authController = require('../controllers/auth.controller');

const router = express.Router();

// POST /api/auth/login
router.post('/login', authController.login);
router.get('/callback', authController.callback); // Handle Salesforce callback

module.exports = router;