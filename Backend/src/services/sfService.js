const logger = require('../utils/logger')(__filename); 

class SalesforceService {
  /**
   * Fetches only Standard Objects (Account, Contact, etc.)
   */
  async getStandardObjects(conn) {
    try {
      logger.info('Executing describeGlobal to fetch standard objects');
      
      const meta = await conn.describeGlobal();
      
      const standardObjects = meta.sobjects
        .filter(obj => !obj.custom && obj.queryable)
        .map(obj => ({
          name: obj.name,
          label: obj.label,
          keyPrefix: obj.keyPrefix
        }));

      logger.info('Successfully fetched standard objects', { 
        objectCount: standardObjects.length 
      });
      
      return standardObjects;
      
    } catch (error) {
      logger.error('Salesforce API Error: Failed to fetch standard objects', { 
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
}

module.exports = new SalesforceService();