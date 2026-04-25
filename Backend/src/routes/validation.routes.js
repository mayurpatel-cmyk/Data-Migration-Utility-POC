const express = require('express');
const router = express.Router();
const validationController = require('../controllers/validation.controller');
const requireSalesforceAuth = require('../middlewares/auth.middleware');
const multer = require('multer');

// FIXED: Save to disk instead of RAM to prevent Out of Memory crashes
const upload = multer({ dest: 'uploads/' });

// 1. Extract Headers: Requires file upload, auth usually optional if just reading headers
router.post(
  '/extract-headers', 
  upload.single('file'), 
  validationController.extractHeaders
);

// 2. Validate Data: Requires Auth (for sfConn), then file upload, then the controller
router.post(
  '/validate-data', 
  requireSalesforceAuth, 
  upload.single('file'), 
  validationController.validateData
);

// 3. Revalidate Data (JSON payload, no file upload needed)
router.post(
  '/revalidate',
  requireSalesforceAuth,
  validationController.revalidateData
);

module.exports = router;