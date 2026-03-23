const logger = require('../utils/logger')(__filename); 

class MigrationService {
 async insertRecords(conn, targetObject, records) {
  try {
    //Filter out empty objects and clean headers
   const cleanRecords = records.map(record => {
        const cleanRow = {};
        Object.entries(record).forEach(([key, value]) => {
          const cleanKey = key.trim();
          if (cleanKey && value !== undefined && value !== null && value !== '') {
            cleanRow[cleanKey] = value;
          }
        });
        return cleanRow;
      }).filter(row => Object.keys(row).length > 0); // Only remove completely empty rows at the end

    if (cleanRecords.length === 0) {
      throw new Error("No valid data rows found after cleaning.");
    }
    logger.info(`Starting Bulk migration: ${cleanRecords.length} records into ${targetObject}`);
    const results = await conn.bulk.load(targetObject, "insert", cleanRecords);

    return { results, sentRecords: cleanRecords };

  } catch (error) {
    if (error.message.includes('InvalidBatch')) {
      logger.error('Bulk API Header Error: Check if your mapped Salesforce field names are valid API names (e.g. No spaces, no special chars).');
    }
    logger.error(`Bulk Migration Service Error: ${error.message}`);
    throw error;
  }
}
}

module.exports = new MigrationService();