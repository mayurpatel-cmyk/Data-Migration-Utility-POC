const validationService = require('../services/ValidationService'); // Adjust path if needed
const logger = require('../utils/logger')(__filename);

exports.validateData = async (req, res) => {
  const email = req.headers['user-email'];
  const { records, mappings, dedupeKey } = req.body;

  try {
    // Basic payload checks
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid payload: No records provided for validation."
      });
    }

    if (!Array.isArray(mappings) || mappings.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid payload: No mappings provided for validation."
      });
    }

    logger.info(`Data Validation Batch started`, {
      userEmail: email,
      recordCount: records.length
    });

    // Execute the validation (Runs synchronously as it doesn't need to hit SF API)
    const result = validationService.validateBatch(records, mappings, dedupeKey);

    logger.info(`Validation batch completed`, {
      valid: result.stats.valid,
      invalid: result.stats.invalid,
      duplicates: result.stats.duplicates
    });

    // Return the formatted response matching the frontend expectations
    res.json({
      success: true,
      message: `Validation finished!`,
      stats: result.stats,
      validRecords: result.validRecords,
      invalidRecords: result.invalidRecords
    });

  } catch (error) {
    logger.error('Validation Controller Error', {
      error: error.message,
      userEmail: email,
      stack: error.stack
    });

    res.status(500).json({
      success: false,
      message: error.message || "Internal Server Error during validation"
    });
  }
};