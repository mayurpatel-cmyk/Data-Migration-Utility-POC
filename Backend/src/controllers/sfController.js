const sfService = require('../services/sfService');
const logger = require('../utils/logger')(__filename);

exports.getStandardObjects = async (req, res) => {
  const email = req.headers['user-email']; 
  
  try {
    const conn = req.sfConn; 

    if (!conn) {
      logger.warn('Failed to fetch standard objects: No active Salesforce connection', {
        userEmail: email,
        endpoint: req.originalUrl
      });
      return res.status(401).json({ success: false, message: "No active Salesforce connection found." });
    }

    logger.info('Fetching standard Salesforce objects', { userEmail: email });

    const meta = await conn.describeGlobal();
    const standardObjects = meta.sobjects
      .filter(obj => !obj.custom && obj.queryable)
      .map(obj => ({ name: obj.name, label: obj.label }));

    logger.info('Successfully fetched standard objects', { 
      userEmail: email, 
      objectCount: standardObjects.length 
    });

    res.json({ success: true, data: standardObjects });
  } catch (error) {
    logger.error('Error fetching standard Salesforce objects', {
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