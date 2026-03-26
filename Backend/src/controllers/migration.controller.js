const migrationService = require('../services/migration.service');
const logger = require('../utils/logger')(__filename);

exports.migrateData = async (req, res) => {
  const email = req.headers['user-email'];
  const jobs = req.body; // Angular now sends an array of jobs directly as the body

  try {
    const conn = req.sfConn;

    if (!conn) {
      return res.status(401).json({
        success: false,
        message: "No active Salesforce connection found. Please log in again."
      });
    }

    // Validate that jobs is an array and has at least one item
    if (!Array.isArray(jobs) || jobs.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid payload: No migration jobs provided."
      });
    }

    logger.info(`Bulk Migration Batch started`, {
      userEmail: email,
      jobCount: jobs.length
    });

    // We pass the Array of Jobs directly into the service. 
    // We don't need a third parameter anymore.
    const result = await migrationService.insertRecords(conn, jobs);

    logger.info(`Migration batch completed`, {
      success: result.stats.success,
      failed: result.stats.failed
    });

    // Send the aggregated results straight back to Angular
    res.json({
      success: true,
      message: `Migration batch finished!`,
      stats: result.stats,
      failures: result.failures,
      successfulRecords: result.successfulRecords
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