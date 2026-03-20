const authService = require('../services/auth.service');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger')(__filename);

const login = async (req, res) => {
  const { email, password, environment } = req.body;

  try {
    // 1. Initial Logging
    logger.info('Login request received', { email, environment });

    // 2. Body Validation
    if (!email || !password || !environment) {
      logger.warn('Validation failed: Missing fields', { email, environment });
      return res.status(400).json({ 
        success: false, 
        message: 'Email, password, and environment are required' 
      });
    }

    // 3. Service Call
    const authData = await authService.loginToSalesforce(email, password, environment);
    const token = jwt.sign(
      { 
        id: authData.user.id, 
        email: email, 
        sfUrl: authData.user.sfUrl, 
        accessToken: authData.user.accessToken 
      }, 
      process.env.JWT_SECRET, 
      { expiresIn: '12h' }
    );

    logger.info('Authentication successful, token generated', { userId: authData.user.id });

    // // 4. Success Response
    // logger.info('Authentication successful', { userId: authData.user.id });
    return res.status(200).json({
      success: true,
      message: `Successfully authenticated with Salesforce ${environment}`,
      user: authData.user,// This matches your AuthResponse interface in Angular
      token: token
    });

  } catch (error) {
    // 5. Error Handling
    // If it's a known Salesforce error, send 401, otherwise 500
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