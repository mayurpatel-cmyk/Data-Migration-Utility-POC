const jsforce = require('jsforce');
const logger = require('../utils/logger')(__filename);

const loginToSalesforce = async (email, password, environment) => {
  const loginUrl = environment === 'sandbox' 
    ? 'https://test.salesforce.com' 
    : 'https://login.salesforce.com';

  const conn = new jsforce.Connection({ loginUrl });

  try {
    // Note: 'password' should include Security Token if IP is not whitelisted
    const userInfo = await conn.login(email, password);
    
    logger.info(`JSForce connection successful`, { 
      email, 
      instanceUrl: conn.instanceUrl 
    });

    // Structure this to match your Angular AuthResponse interface
    return {
      user: {
        id: userInfo.id,
        email: email,
        environment: environment,
        sfUrl: conn.instanceUrl, // Mapping instanceUrl to sfUrl for your frontend
        accessToken: conn.accessToken
      }
    };

  } catch (error) {
    logger.error('Salesforce Login Error', { 
      email, 
      sfError: error.message 
    });

    // Create a specific error to catch in the controller
    const authError = new Error(error.message || 'Invalid Salesforce credentials');
    authError.name = 'SalesforceAuthError';
    throw authError;
  }
};

module.exports = { loginToSalesforce };