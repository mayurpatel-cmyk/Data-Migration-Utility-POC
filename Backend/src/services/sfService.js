const logger = require('../utils/logger')(__filename); 

class SalesforceService {

  async getAllObjects(conn) {
    try {
      logger.info('Executing describeGlobal to fetch all objects');
      
      const meta = await conn.describeGlobal();
      
      const allObjects = meta.sobjects.map(obj => ({
          name: obj.name,
          label: obj.label,
          keyPrefix: obj.keyPrefix,
          // NEW: Identify if the object is a Custom Metadata Type, Custom Object, or Standard
          isCustomMetadata: obj.name.endsWith('__mdt'),
          isCustomObject: obj.name.endsWith('__c')
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

// async getAllCustomMetadataTypes(conn) {
//     try {
//       logger.info('Fetching list of Custom Metadata Types');
//       const allObjects = await this.getAllObjects(conn);
      
//       const mdtObjects = allObjects.filter(obj => obj.isCustomMetadata);
      
//       logger.info('Successfully filtered Custom Metadata Types', {
//         mdtCount: mdtObjects.length
//       });
      
//       return mdtObjects;
//     } catch (error) {
//       logger.error('Service Error: Failed to fetch Custom Metadata Types', { 
//         error: error.message 
//       });
//       throw error;
//     }
//   }

//   // NEW METHOD: Fetch records for a specific Custom Metadata Type
//   async getCustomMetadataRecords(conn, mdtObjectName) {
//     try {
//       // Safety check to ensure we are querying an MDT
//       if (!mdtObjectName.endsWith('__mdt')) {
//         throw new Error(`Invalid Object Name: ${mdtObjectName}. Must end with __mdt`);
//       }
//       logger.info(`Fetching records for Custom Metadata Type: ${mdtObjectName}`);
//       const records = await conn.sobject(mdtObjectName).find();

//       logger.info(`Successfully fetched records for ${mdtObjectName}`, {
//         recordCount: records.length
//       });

//       return records;
//     } catch (error) {
//       logger.error(`Service Error: Failed to fetch records for ${mdtObjectName}`, {
//         error: error.message,
//         stack: error.stack
//       });
//       throw error;
//     }
//   }

  async getFieldsForObject(conn, objectName) {
    try {
      logger.info(`Executing describe for object: ${objectName}`);
      
      const meta = await conn.sobject(objectName).describe();
      
      const fields = meta.fields.map(field => ({
        name: field.name,
        label: field.label,
        type: field.type,
        length: field.length,
        custom: field.custom,
        isRequired: !field.nillable && field.createable && !field.defaultedOnCreate,
        // NEW: Capture relationship targets (e.g., ['Account'])
        referenceTo: field.referenceTo && field.referenceTo.length > 0 ? field.referenceTo : null
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