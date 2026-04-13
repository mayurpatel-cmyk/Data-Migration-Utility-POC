const jsforce = require('jsforce');
const logger = require('../utils/logger')(__filename);


// 1. Initialize OAuth2 with your credentials


/**
 * STEP 1: Generate the Salesforce Login URL
 * This works for ANY org based on the environment chosen.
 */
const getAuthUrl = (environment) => {
  // Normalize environment to lowercase for consistent comparison
  const normalizedEnv = (environment || '').toLowerCase().trim();

  console.log('--- Auth Request Received ---');
  console.log('Target Environment (raw):', environment);
  console.log('Target Environment (normalized):', normalizedEnv);
  
  let proxyUrl = '';
  if (normalizedEnv === 'sandbox') {
    proxyUrl = 'https://test.salesforce.com';
    console.log('Using SANDBOX URL:', proxyUrl);
    logger.info(`Using Sandbox Environment: ${proxyUrl}`);
  } else if (normalizedEnv === 'production') {
    proxyUrl = 'https://login.salesforce.com';
    console.log('Using PRODUCTION URL:', proxyUrl);
    logger.info(`Using Production Environment: ${proxyUrl}`);
  } else {
    // Default to production if environment is unclear
    proxyUrl = 'https://login.salesforce.com';
    console.warn('Unknown environment received, defaulting to PRODUCTION:', normalizedEnv);
    logger.warn(`Unknown Environment: ${normalizedEnv}, defaulting to Production`);
  }

  const oauth2 = new jsforce.OAuth2({
  loginUrl: proxyUrl,
  clientId: process.env.SF_CONSUMER_KEY,
  clientSecret: process.env.SF_CONSUMER_SECRET,
  redirectUri: 'http://localhost:3000/api/auth/callback'
  
});

  return oauth2.getAuthorizationUrl({ 
    scope: 'api refresh_token',
    // Do NOT pass redirect_uri here if it's already in the constructor
    prompt: 'login',
    state: environment
  });
};

/**
 * STEP 2: Exchange the code for a Token
 * This happens after the user logs into Salesforce.
 */
const authorize = async (code,environment) => {

  const proxyUrl = environment === 'sandbox' 
    ? 'https://test.salesforce.com' 
    : 'https://login.salesforce.com';

  const oauth2 = new jsforce.OAuth2({
    loginUrl: proxyUrl,
    clientId: process.env.SF_CONSUMER_KEY,
    clientSecret: process.env.SF_CONSUMER_SECRET,
    redirectUri: 'http://localhost:3000/api/auth/callback'
  });
  const conn = new jsforce.Connection({ oauth2: oauth2 });
  const userInfo = await conn.authorize(code);
  
  const identity = await conn.identity();

  return {
    accessToken: conn.accessToken,
    instanceUrl: conn.instanceUrl,
    userId: conn.userInfo.id,
    userName: identity.display_name,

  };
};

module.exports = { getAuthUrl, authorize };