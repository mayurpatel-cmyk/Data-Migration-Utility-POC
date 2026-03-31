const migrationService = require('../services/migration.service');
const logger = require('../utils/logger')(__filename);

exports.migrateData = async (req, res) => {
  const email = req.headers['user-email'];
  const jobs = req.body; 

  try {
    const conn = req.sfConn;

    if (!conn) {
      return res.status(401).json({
        success: false,
        message: "No active Salesforce connection found. Please log in again."
      });
    }

    if (!Array.isArray(jobs) || jobs.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid payload: No migration jobs provided."
      });
    }

    logger.info(`Bulk Upsert Batch started`, {
      userEmail: email,
      jobCount: jobs.length
    });

    // Execute the batch migration
    const result = await migrationService.executeUpsertBatch(conn, jobs);

    // ----------------------------------------------------------------------
    // NEW LOGIC: Format successful and failed records for the frontend
    // Note: This expects migrationService to return { results, sentRecords }
    // If your service already formats this data, you can remove this block.
    // ----------------------------------------------------------------------
    const rawResults = result.results || [];
    const sentRecords = result.sentRecords || [];
    
    let successfulRecords = result.successfulRecords || [];
    let failures = result.failures || [];
    let stats = result.stats || { success: 0, failed: 0 };

    // Apply the formatting if raw results were returned
    if (rawResults.length > 0 && sentRecords.length > 0) {
      successfulRecords = rawResults
        .map((resItem, index) => {
          if (resItem.success) {
            return {
              SalesforceId: resItem.id, // The new Salesforce ID
              ...sentRecords[index]
            };
          }
          return null;
        })
        .filter(record => record !== null);

      failures = rawResults
        .map((resItem, index) => {
          if (!resItem.success) {
            let errorMessage = 'Unknown Error';
            
            if (Array.isArray(resItem.errors) && resItem.errors.length > 0) {
              // If it's an array of strings, we just join them.
              // If they are objects, we grab the message.
              errorMessage = resItem.errors
                .map(e => (typeof e === 'string' ? e : (e.message || JSON.stringify(e))))
                .join(', ');
            } else if (resItem.error) {
              errorMessage = resItem.error;
            }

            return {
              record: sentRecords[index], // Original data for the first column
              error: errorMessage         // Cleaned up string for the second column
            };
          }
          return null;
        })
        .filter(record => record !== null);

      // Recalculate stats based on formatted data
      stats = {
        success: successfulRecords.length,
        failed: failures.length
      };
    }
    // ----------------------------------------------------------------------

    logger.info(`Upsert batch completed`, {
      success: stats.success,
      failed: stats.failed
    });

    res.json({
      success: true,
      message: `Migration batch finished!`,
      stats: stats,
      failures: failures,
      successfulRecords: successfulRecords
    });

  } catch (error) {
    logger.error('Migration Controller Error', {
      error: error.message,
      userEmail: email,
      stack: error.stack
    });

    res.status(500).json({
      success: false,
      message: error.message || "Internal Server Error during migration"
    });
  }
};