const jsforce = require('jsforce');
const logger = require('../utils/logger')(__filename);
const fetch = require('node-fetch');

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
 * STEP 1 (ZOHO): Generate a Unified Global Login Entry Endpoint
 * Pointing to the base .com accounts server allows Zoho to read 
 * incoming user credentials and route them to their home data center automatically.
 */
const getZohoAuthUrl = () => {
  const scopes = [
    'ZohoCRM.modules.ALL',
    'ZohoCRM.bulk.READ',
    'ZohoCRM.settings.FIELDS.READ',
    'ZohoCRM.settings.modules.READ'
  ].join(',');

  // prompt=consent & access_type=offline are required to enforce a permanent refresh_token return
  return `https://accounts.zoho.com/oauth/v2/auth?scope=${scopes}&client_id=${process.env.ZOHO_CLIENT_ID}&response_type=code&access_type=offline&redirect_uri=${encodeURIComponent(process.env.ZOHO_REDIRECT_URI)}&prompt=consent`;
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

/**
 * STEP 2 (ZOHO): Exchange Authorization Grant Code for Long-Lived Tokens
 * This must hit the dynamic, regional accountsServer passed back by Zoho's callback.
 */
const authorizeZoho = async (code, accountsServer) => {
  const tokenUrl = `${accountsServer}/oauth/v2/token`;
  logger.info(`Exchanging Zoho auth code at dynamic regional endpoint: ${tokenUrl}`);

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    redirect_uri: process.env.ZOHO_REDIRECT_URI,
    code: code
  });

  const response = await fetch(tokenUrl, { method: 'POST', body: params });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Zoho multi-tenant verification failed: ${errorBody}`);
  }

  const tokenData = await response.json();
  
  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token, // Encrypt and save this long-lived token safely to your session store
    apiDomain: tokenData.api_domain,       // Dynamic localized API endpoint (e.g. https://www.zohoapis.in or https://www.zohoapis.eu)
    accountsServer: accountsServer,        // Store this domain target to execute silent background token updates later
    expiresIn: tokenData.expires_in
  };
};
/**
 * STEP 3 (ZOHO): Background Access Token Rotation Engine
 * Invoked automatically by your backend handlers when an active token approaches expiration
 */
const refreshZohoToken = async (savedRefreshToken, accountsServer) => {
  const tokenUrl = `${accountsServer}/oauth/v2/token`;
  
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    refresh_token: savedRefreshToken
  });

  const response = await fetch(tokenUrl, { method: 'POST', body: params });
  if (!response.ok) throw new Error("Could not rotate stale Zoho access token.");

  const data = await response.json();
  return data.access_token;
};

module.exports = { 
   getAuthUrl,
   authorize,
   getZohoAuthUrl,
   authorizeZoho,
   refreshZohoToken
};