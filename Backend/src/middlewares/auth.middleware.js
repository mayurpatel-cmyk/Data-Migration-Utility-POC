const jsforce = require('jsforce');
const logger = require('../utils/logger')(__filename);

const requireSalesforceAuth = (req, res, next) => {
  const instanceUrl = req.headers.instanceurl;
  const accessToken = req.headers.accesstoken;

  if ( !instanceUrl || !accessToken) {
    logger.warn('Unauthorized request: Missing Salesforce Token or Instance URL', {
      hasInstanceUrl: !!instanceUrl,
      hasAccessToken: !!accessToken,
      endpoint: req.originalUrl 
    });

    return res.status(401).json({ 
      success: false, 
      message: 'Unauthorized: Missing Salesforce Token or Instance URL' 
    });
  }

  try {
    // Reconstruct the jsforce connection without needing a password!
    req.sfConn = new jsforce.Connection({
      instanceUrl: instanceUrl,
      accessToken: accessToken
    });

    logger.info('Salesforce connection reconstructed from headers', {
      instanceUrl: instanceUrl,
      endpoint: req.originalUrl
    });

    next(); 
  } catch (error) {
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