const migrationService = require('../services/migration.service');
const hubspotMigrationService = require('../services/hubspotMigration.service');
const zohoMigrationService = require('../services/zohoMigration.service');
const logger = require('../utils/logger')(__filename);

/**
 * Multi-CRM Migration Controller
 * Routes migrations to appropriate CRM-specific service based on target CRM
 */

exports.migrateData = async (req, res) => {
  const email = req.headers['user-email'];
  const targetCrm = req.headers['target-crm']; // 'salesforce', 'zoho', or 'hubspot'
  const jobs = req.body;

  try {
    // Validate input
    if (!targetCrm) {
      return res.status(400).json({
        success: false,
        message: "Missing 'target-crm' header. Must be one of: salesforce, zoho, hubspot"
      });
    }

    if (!Array.isArray(jobs) || jobs.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid payload: No migration jobs provided."
      });
    }

    logger.info(`Migration initiated to ${targetCrm}`, {
      userEmail: email,
      jobCount: jobs.length,
      targetCrm
    });

    let result;

    // Route to appropriate migration service
    switch (targetCrm.toLowerCase()) {
      case 'salesforce':
        result = await migrateTosalesforce(req, jobs);
        break;

      case 'zoho':
        result = await migrateToZoho(req, jobs);
        break;

      case 'hubspot':
        result = await migrateToHubSpot(req, jobs);
        break;

      default:
        return res.status(400).json({
          success: false,
          message: `Unsupported target CRM: ${targetCrm}. Must be one of: salesforce, zoho, hubspot`
        });
    }

    const stats = {
      success: result.successfulRecords?.length || 0,
      failed: result.failures?.length || 0
    };

    logger.info(`Migration to ${targetCrm} completed`, {
      ...stats,
      userEmail: email
    });

    res.json({
      success: true,
      message: `Migration to ${targetCrm} finished!`,
      stats: stats,
      failures: result.failures || [],
      successfulRecords: result.successfulRecords || []
    });

  } catch (error) {
    logger.error('Multi-CRM Migration Error', {
      error: error.message,
      userEmail: email,
      targetCrm,
      stack: error.stack
    });

    res.status(500).json({
      success: false,
      message: error.message || "Internal Server Error during migration"
    });
  }
};

/**
 * Migrate to Salesforce
 */
async function migrateTosalesforce(req, jobs) {
  const conn = req.sfConn;

  if (!conn) {
    throw new Error("No active Salesforce connection found. Please log in again.");
  }

  const result = await migrationService.executeUpsertBatch(conn, jobs);
  return result;
}

/**
 * Migrate to Zoho CRM
 */
async function migrateToZoho(req, jobs) {
  const accessToken = req.headers['zoho-access-token'];
  const apiDomain = req.headers['zoho-api-domain'];

  if (!accessToken || !apiDomain) {
    throw new Error("No active Zoho connection found. Please log in again.");
  }

  const result = await zohoMigrationService.executeBatch(accessToken, apiDomain, jobs);
  return result;
}

/**
 * Migrate to HubSpot
 */
async function migrateToHubSpot(req, jobs) {
  const accessToken = req.headers['hubspot-access-token'];

  if (!accessToken) {
    throw new Error("No active HubSpot connection found. Please log in again.");
  }

  const result = await hubspotMigrationService.executeBatch(accessToken, jobs);
  return result;
}
