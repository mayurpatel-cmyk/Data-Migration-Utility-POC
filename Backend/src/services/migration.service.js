const logger = require('../utils/logger')(__filename); 

class MigrationService {
  async insertRecords(conn, targetObject, records) {
    try {
      logger.info(`Starting migration: Inserting ${records.length} records into ${targetObject}`);
      
      const results = [];
      const chunkSize = 200; // Salesforce REST API batch limit

      // Process the records in safe chunks
      for (let i = 0; i < records.length; i += chunkSize) {
        const chunk = records.slice(i, i + chunkSize);
        
        logger.info(`Processing batch ${Math.floor(i / chunkSize) + 1} of ${Math.ceil(records.length / chunkSize)}...`);
        
        // Push the chunk to Salesforce
        const chunkResults = await conn.sobject(targetObject).create(chunk, { allowRecursive: true });
        
        // Ensure results are always pushed as an array
        results.push(...(Array.isArray(chunkResults) ? chunkResults : [chunkResults]));
      }

      logger.info(`Successfully completed migration to ${targetObject}`);
      return results;

    } catch (error) {
      logger.error(`Migration Failed for ${targetObject}`, { 
        error: error.message, 
        stack: error.stack 
      });
      throw error; 
    }
  }
}
  module.exports = new MigrationService();