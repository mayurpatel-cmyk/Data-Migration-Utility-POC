const authService = require('../services/auth.service');
const logger = require('../utils/logger')(__filename);

const login = async (req, res) => {
  const { email, password, environment } = req.body;

  try {
    logger.info('Login request received', { email, environment });

    if (!email || !password || !environment) {
      logger.warn('Validation failed: Missing fields', { email, environment });
      return res.status(400).json({ 
        success: false, 
        message: 'Email, password, and environment are required' 
      });
    }

    const authData = await authService.loginToSalesforce(email, password, environment);
    logger.info('Authentication successful', { userId: authData.user.id });
    return res.status(200).json({
      success: true,
      message: `Successfully authenticated with Salesforce ${environment}`,
      user: authData.user
    });

  } catch (error) {
    const statusCode = error.name === 'SalesforceAuthError' ? 401 : 500;
    
    logger.error('Login process failed', { 
      message: error.message, 
      email, 
      stack: error.stack 
    });

    return res.status(statusCode).json({ 
      success: false, 
      message: error.message 
    });
  }
};

module.exports = { login };