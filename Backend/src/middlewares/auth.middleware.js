// middlewares/auth.middleware.js
const jsforce = require('jsforce');
const logger = require('../utils/logger')(__filename); // 1. Import your logger

const requireSalesforceAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const instanceUrl = req.headers['x-sf-url'];

  // 2. Log Warning if headers are missing
  if (!authHeader || !authHeader.startsWith('Bearer ') || !instanceUrl) {
    logger.warn('Unauthorized request: Missing Salesforce Token or Instance URL', {
      hasAuthHeader: !!authHeader,
      hasInstanceUrl: !!instanceUrl,
      endpoint: req.originalUrl 
    });

    return res.status(401).json({ 
      success: false, 
      message: 'Unauthorized: Missing Salesforce Token or Instance URL' 
    });
  }

  const accessToken = authHeader.split(' ')[1]; // Extracts token after "Bearer "

  try {
    // Reconstruct the jsforce connection without needing a password!
    req.sfConn = new jsforce.Connection({
      instanceUrl: instanceUrl,
      accessToken: accessToken
    });

    // 3. Log Success (Optional: change to logger.debug if this gets too noisy in production)
    logger.info('Salesforce connection reconstructed from headers', {
      instanceUrl: instanceUrl,
      endpoint: req.originalUrl
    });

    next(); 
  } catch (error) {
    // 4. Log Error if jsforce fails to initialize
    logger.error('Failed to initialize Salesforce connection', { 
      error: error.message,
      stack: error.stack,
      instanceUrl: instanceUrl,
      endpoint: req.originalUrl
    });

    return res.status(500).json({ 
      success: false, 
      message: 'Failed to initialize Salesforce connection' 
    });
  }
};

module.exports = requireSalesforceAuth;