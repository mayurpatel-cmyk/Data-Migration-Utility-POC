const authService = require('../services/auth.service');
const logger = require('../utils/logger')(__filename);

// 1. Redirect User to Salesforce
const login = async (req, res) => {
  const { environment } = req.body; // User picks 'production' or 'sandbox'

  try {
    if (!environment) {
      logger.warn('Login request missing environment parameter');
      return res.status(400).json({ success: false, message: 'Environment is required' });
    }

    // Validate environment value
    const validEnvironments = ['production', 'sandbox'];
    if (!validEnvironments.includes(environment.toLowerCase())) {
      logger.warn('Invalid environment received', { environment });
      return res.status(400).json({ success: false, message: 'Invalid environment. Must be production or sandbox.' });
    }

    // Log the request with the received environment
    logger.info('Login request received', { environment: environment.toLowerCase() });

    // This calls the authService.getAuthUrl() we discussed earlier
    const authUrl = authService.getAuthUrl(environment.toLowerCase());
    
    logger.info('Generated Salesforce Auth URL successfully', { environment: environment.toLowerCase() });
    logger.debug('Generated Auth URL', { authUrl, environment: environment.toLowerCase() });

    return res.status(200).json({ success: true, url: authUrl });
  } catch (error) {
    logger.error('Failed to generate Auth URL', { error: error.message, environment: req.body.environment });
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
};

// 2. Handle the Callback from Salesforce
// Add this to your routes: router.get('/callback', authController.callback);
const callback = async (req, res) => {
  const { code, state } = req.query; // Salesforce sends a 'code' in the URL

  try {
    const authData = await authService.authorize(code, state);
    
    logger.info('OAuth Callback Successful', { userId: authData.userId });

    // Redirect the browser back to your Angular Dashboard with the token
    // Angular will pick up these parameters from the URL
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:4200';
    res.redirect(`${frontendUrl}/dashboard?token=${authData.accessToken}&instanceUrl=${authData.instanceUrl}&name=${encodeURIComponent(authData.userName)}`);
    
  } catch (error) {
    logger.error('OAuth Callback Failed', { error: error.message });
    res.redirect(`${process.env.FRONTEND_URL}/login?error=AuthenticationFailed`);
  }
};

module.exports = { login, callback };