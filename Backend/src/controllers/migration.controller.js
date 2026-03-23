const migrationService = require('../services/migration.service');
const logger = require('../utils/logger')(__filename);

exports.migrateData = async (req, res) => {
  const email = req.headers['user-email'];
  const { targetObject, records } = req.body;

  try {
    const conn = req.sfConn;

    if (!conn) {
      return res.status(401).json({
        success: false,
        message: "No active Salesforce connection found. Please log in again."
      });
    }

    if (!targetObject || !records || !Array.isArray(records) || records.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid payload: Target object or records missing."
      });
    }

    logger.info(`Bulk Migration started for ${targetObject}`, {
      userEmail: email,
      recordCount: records.length
    });

    const { results, sentRecords } = await migrationService.insertRecords(conn, targetObject, records);

    //  Calculate Success vs Failures
    const successfulCount = results.filter(r => r.success === true).length;
    const failedCount = results.filter(r => r.success === false).length;

    //include the 'row' index to help the user identify which row in their CSV failed
    const errorDetails = results
      .map((r, index) => ({ row: index + 1, result: r }))
      .filter(item => item.result.success === false)
      .map(item => ({
        row: item.row,
        //API can return errors in .errors or .error depending on the failure type
        message: item.result.errors ? item.result.errors.map(e => e.message).join(', ') : (item.result.error || 'Unknown Error')
      }));

    logger.info(`Migration completed for ${targetObject}`, {
      total: records.length,
      success: successfulCount,
      failed: failedCount
    });

    const failures = results
      .map((result, index) => {
        if (!result.success) {
          return {
            // We attach the original data so frontend can show "Account Name" or "Email"
            record: sentRecords[index], 
            error: result.errors ? result.errors.map(e => e.message).join(', ') : (result.error || 'Unknown Salesforce Error')
          };
        }
        return null;
      })
      .filter(item => item !== null);

    // 5. Send Results Back to Angular
    res.json({
      success: true,
      message: `Migration finished!`,
      stats: {
        total: sentRecords.length,
        success: successfulCount,
        failed: failedCount
      },
      failures: failures,
      // Only send the first 100 errors to avoid bloating the response
      // errors: errorDetails.length > 0 ? errorDetails.slice(0, 100) : null
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