const migrationService = require('../services/migration.service');
const logger = require('../utils/logger')(__filename);

exports.migrateData = async (req, res) => {
  const email = req.headers['user-email']; 
  const { targetObject, records } = req.body;

  try {
    const conn = req.sfConn; 

    // 1. Validation
    if (!conn) {
      return res.status(401).json({ success: false, message: "No active Salesforce connection found." });
    }
    if (!targetObject || !records || !Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ success: false, message: "Missing target object or empty records payload." });
    }

    logger.info(`Migration request received for ${targetObject}`, { userEmail: email, recordCount: records.length });

    // 2. Execute Migration
    const results = await migrationService.insertRecords(conn, targetObject, records);

    // 3. Calculate Success vs Failures
    const successfulCount = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;

    // Grab the errors for any records that failed (e.g., missing required fields)
    const errors = results
      .filter(r => !r.success)
      .map(r => ({ id: r.id, errors: r.errors }));

    // 4. Send Results Back to Angular
    res.json({ 
      success: true, 
      message: `Migration finished! Successfully inserted ${successfulCount} records. Failed: ${failedCount}.`,
      stats: {
        total: records.length,
        success: successfulCount,
        failed: failedCount
      },
      errors: errors.length > 0 ? errors : null
    });

  } catch (error) {
    logger.error('Migration Controller Error', { error: error.message, userEmail: email });
    res.status(500).json({ success: false, error: "Migration failed", details: error.message });
  }
};