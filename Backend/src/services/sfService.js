const logger = require('../utils/logger')(__filename); 

class SalesforceService {
  /**
   * Fetches only Standard Objects (Account, Contact, etc.)
   */
  async getAllObjects(conn) {
    try {
      logger.info('Executing describeGlobal to fetch all objects');
      
      const meta = await conn.describeGlobal();
      
      // Removed the filter here as well
      const allObjects = meta.sobjects.map(obj => ({
          name: obj.name,
          label: obj.label,
          keyPrefix: obj.keyPrefix
        }));

      logger.info('Successfully fetched all objects', { 
        objectCount: allObjects.length 
      });
      
      return allObjects;
      
    } catch (error) {
      logger.error('Salesforce API Error: Failed to fetch all objects', { 
        error: error.message, 
        stack: error.stack 
      });
      throw error; 
    }
}

  /**
   * Fetches all fields for a specific object
   */
  async getFieldsForObject(conn, objectName) {
    try {
      logger.info(`Executing describe for object: ${objectName}`);
      
      const meta = await conn.sobject(objectName).describe();
      
      const fields = meta.fields.map(field => ({
        name: field.name,
        label: field.label,
        type: field.type,
        length: field.length,
        custom: field.custom 
      }));

      logger.info(`Successfully fetched fields for object: ${objectName}`, { 
        fieldCount: fields.length 
      });
      
      return fields;

    } catch (error) {
      logger.error(`Salesforce API Error: Failed to fetch fields for object: ${objectName}`, { 
        error: error.message, 
        stack: error.stack,
        objectName: objectName
      });
      throw error; 
    }
  }

async getCurrentUserInfo(conn) {
    try {
      // Reconstructed connections lack userInfo. Fetch it manually:
      const identity = await conn.identity();
      const userId = identity.user_id;

      const userData = await conn.query(
        `SELECT Id, Name, Email, Username, CompanyName FROM User WHERE Id = '${userId}'`
      );

      return userData.records[0];
    } catch (error) {
      logger.error('Service Error: User Info', { error: error.message });
      throw error;
    }
  }
}

module.exports = new SalesforceService();