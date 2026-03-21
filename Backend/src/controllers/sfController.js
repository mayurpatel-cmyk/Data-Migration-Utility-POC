const sfService = require('../services/sfService');
const logger = require('../utils/logger')(__filename);

exports.getAllObjects = async (req, res) => {
  const email = req.headers['user-email']; 
  
  try {
    const conn = req.sfConn; 

    if (!conn) {
      logger.warn('Failed to fetch objects: No active Salesforce connection', {
        userEmail: email,
        endpoint: req.originalUrl
      });
      return res.status(401).json({ success: false, message: "No active Salesforce connection found." });
    }

    logger.info('Fetching all Salesforce objects', { userEmail: email });

    const meta = await conn.describeGlobal();
    
    // Removed the filter here to map all objects directly
    const allObjects = meta.sobjects.map(obj => ({ 
      name: obj.name, 
      label: obj.label 
    }));

    logger.info('Successfully fetched all objects', { 
      userEmail: email, 
      objectCount: allObjects.length 
    });

    res.json({ success: true, data: allObjects });
  } catch (error) {
    logger.error('Error fetching Salesforce objects', {
      error: error.message,
      stack: error.stack,
      userEmail: email,
      endpoint: req.originalUrl
    });
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getObjectFields = async (req, res) => {
  const { objectName } = req.params;
  const email = req.headers['user-email'];

  try {
    logger.info(`Fetching fields for object: ${objectName}`, { userEmail: email });

    const fields = await sfService.getFieldsForObject(req.sfConn, objectName);
    
    logger.info(`Successfully fetched fields for object: ${objectName}`, { 
      userEmail: email,
      fieldCount: fields ? fields.length : 0
    });

    res.json({ success: true, object: objectName, fields });
  } catch (error) {
    logger.error(`Error fetching fields for object: ${objectName}`, {
      error: error.message,
      stack: error.stack,
      objectName: objectName,
      userEmail: email,
      endpoint: req.originalUrl
    });
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getUserDetails = async (req, res) => {
  const email = req.headers['user-email']; 
  
  try {
    const conn = req.sfConn; 

    // 1. Connection Check
    if (!conn) {
      logger.warn('Failed to fetch user details: No active Salesforce connection', {
        userEmail: email,
        endpoint: req.originalUrl
      });
      return res.status(401).json({ 
        success: false, 
        message: "No active Salesforce connection found." 
      });
    }

    logger.info('Fetching Salesforce user profile', { userEmail: email });

    // 2. Call the service method we created earlier
    const userDetails = await sfService.getCurrentUserInfo(conn);

    // 3. Log success
    logger.info('Successfully fetched user details', { 
      userEmail: email, 
      sfUsername: userDetails.username 
    });

    // 4. Send response to frontend
    res.json({ 
      success: true, 
      data: userDetails 
    });

  } catch (error) {
    logger.error('Error fetching Salesforce user details', {
      error: error.message,
      stack: error.stack,
      userEmail: email,
      endpoint: req.originalUrl
    });
    
    res.status(500).json({ 
      success: false, 
      error: "Internal Server Error",
      details: error.message 
    });
  }
};