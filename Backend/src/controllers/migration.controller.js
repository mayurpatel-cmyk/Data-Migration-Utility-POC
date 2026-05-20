// const migrationService = require('../services/migration.service');
// const logger = require('../utils/logger')(__filename);

// exports.migrateData = async (req, res) => {
//   const email = req.headers['user-email'];
//   const jobs = req.body;

//   try {
//     const conn = req.sfConn;

//     if (!conn) {
//       return res.status(401).json({
//         success: false,
//         message: "No active Salesforce connection found. Please log in again."
//       });
//     }

//     if (!Array.isArray(jobs) || jobs.length === 0) {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid payload: No migration jobs provided."
//       });
//     }

//     logger.info(`Bulk Upsert Batch started`, {
//       userEmail: email,
//       jobCount: jobs.length
//     });

//     // Execute the batch migration
//     const result = await migrationService.executeUpsertBatch(conn, jobs);

//     const rawResults = result.results || [];
//     const sentRecords = result.sentRecords || [];

//     let successfulRecords = result.successfulRecords || [];
//     let failures = result.failures || [];
//     let stats = result.stats || { success: 0, failed: 0 };

//     // Apply the formatting if raw results were returned
//     if (rawResults.length > 0 && sentRecords.length > 0) {
//       successfulRecords = rawResults
//         .map((resItem, index) => {
//           if (resItem.success) {
//             return {
//               SalesforceId: resItem.id, // The new Salesforce ID
//               ...sentRecords[index]
//             };
//           }
//           return null;
//         })
//         .filter(record => record !== null);
//       failures = rawResults
//         .map((resItem, index) => {
//           if (!resItem.success) {
//             let errorMessage = 'Validation Error';

//             if (Array.isArray(resItem.errors) && resItem.errors.length > 0) {
//               // --- SMART ERROR PARSING ---
//               errorMessage = resItem.errors.map(e => {
//                 // Check for Salesforce Duplicate Rule block
//                 if (e.statusCode === 'DUPLICATES_DETECTED') {
//                   return `Duplicate Found: This record already exists in Salesforce. (Rule: ${e.message})`;
//                 }

//                 // Check for standard validation or required fields
//                 if (e.fields && e.fields.length > 0) {
//                   return `${e.message} [Fields: ${e.fields.join(', ')}]`;
//                 }

//                 return e.message || JSON.stringify(e);
//               }).join(' | ');
//             } else if (resItem.error) {
//               errorMessage = resItem.error;
//             }

//             return {
//               record: sentRecords[index], // Keeps the original data for the table's left column
//               error: errorMessage        // Friendly error for the right column
//             };
//           }
//           return null;
//         })
//         .filter(record => record !== null);
//       // Recalculate stats based on formatted data
//       stats = {
//         success: successfulRecords.length,
//         failed: failures.length
//       };
//     }

//     logger.info(`Upsert batch completed`, {
//       success: stats.success,
//       failed: stats.failed
//     });

//     res.json({
//       success: true,
//       message: `Migration batch finished!`,
//       stats: stats,
//       failures: failures,
//       successfulRecords: successfulRecords
//     });

//   } catch (error) {
//     logger.error('Migration Controller Error', {
//       error: error.message,
//       userEmail: email,
//       stack: error.stack
//     });

//     res.status(500).json({
//       success: false,
//       message: error.message || "Internal Server Error during migration"
//     });
//   }
// };

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

    logger.info(`Salesforce Bulk API 2.0 Processing Execution Thread Activated`, {
      userEmail: email,
      jobCount: jobs.length
    });

    let overallSuccess = 0;
    let overallFailed = 0;
    let combinedFailures = [];
    let combinedSuccessRecords = [];

    // Processes jobs sequentially using optimized native JS array operators
    for (const job of jobs) {
      const result = await migrationService.executeBulk2Migration(conn, job);
      
      overallSuccess += result.stats.success;
      overallFailed += result.stats.failed;
      
      // FIXED: Uses standard spread array insertion to preserve strict compatibility with your Node configuration
      combinedFailures.push(...result.failures);
      combinedSuccessRecords.push(...result.successfulRecords);
    }

    logger.info(`Bulk API 2.0 Job Batch processing completed`, {
      success: overallSuccess,
      failed: overallFailed
    });

    res.json({
      success: true,
      message: `Migration batch finished!`,
      stats: { success: overallSuccess, failed: overallFailed },
      failures: combinedFailures,
      successfulRecords: combinedSuccessRecords
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