const logger = require('../utils/logger')(__filename); 

class MigrationService {
  
  // Future-proofed to accept either a single job or an array of migration jobs
  async insertRecords(conn, targetObjectOrJobs, records) {
    try {
      // 1. Normalize input into a "Plan" (Array of Jobs)
      const migrationJobs = Array.isArray(targetObjectOrJobs) 
        ? targetObjectOrJobs 
        : [{ targetObject: targetObjectOrJobs, records: records }];

      let totalSuccess = 0;
      let totalFailed = 0;
      let allFailures = [];
      let allSuccessfulRecords = [];

      // 2. SEQUENTIAL LOOP (Crucial for future Lookup/Reference Key dependencies)
      for (const job of migrationJobs) {
        const { targetObject, records: jobRecords } = job;

        // Clean headers and filter empty objects
        const cleanRecords = jobRecords.map(record => {
          const cleanRow = {};
          Object.entries(record).forEach(([key, value]) => {
            const cleanKey = key.trim();
            if (cleanKey && value !== undefined && value !== null && value !== '') {
              cleanRow[cleanKey] = value;
            }
          });
          return cleanRow;
        }).filter(row => Object.keys(row).length > 0);

        if (cleanRecords.length === 0) {
          logger.warn(`Skipping ${targetObject} - No valid data rows found after cleaning.`);
          continue; 
        }

        logger.info(`Starting Bulk migration: ${cleanRecords.length} records into ${targetObject}`);
        
        // Execute Bulk API
        const results = await conn.bulk.load(targetObject, "insert", cleanRecords);

        // 3. Aggregate Results across all objects
        results.forEach((res, index) => {
          if (res.success) {
            totalSuccess++;
            allSuccessfulRecords.push({ 
              _TargetObject: targetObject, 
              SalesforceId: res.id, // Capture the new SF ID here
              ...cleanRecords[index] 
            });
          } else {
            totalFailed++;
            
            // Robust Error Parsing (Handles jsforce returning strings OR objects)
            let errorMessage = 'Unknown Error';
            if (Array.isArray(res.errors) && res.errors.length > 0) {
              errorMessage = res.errors
                .map(e => (typeof e === 'string' ? e : (e.message || JSON.stringify(e))))
                .join(', ');
            } else if (res.error) {
              errorMessage = res.error;
            }

            allFailures.push({
              error: `[${targetObject}] ${errorMessage}`, // Added Object name for context in the UI
              record: cleanRecords[index]
            });
          }
        });

        // NOTE FOR FUTURE: Here is where you will capture success IDs 
        // and map them to the next job's Reference/Lookup keys!
      }

      // Return unified stats back to the controller
      return { 
        stats: { success: totalSuccess, failed: totalFailed },
        failures: allFailures,
        successfulRecords: allSuccessfulRecords
      };

    } catch (error) {
      if (error.message.includes('InvalidBatch')) {
        logger.error('Bulk API Header Error: Check if your mapped Salesforce field names are valid API names.');
      }
      logger.error(`Bulk Migration Service Error: ${error.message}`);
      throw error;
    }
  }
}

module.exports = new MigrationService();