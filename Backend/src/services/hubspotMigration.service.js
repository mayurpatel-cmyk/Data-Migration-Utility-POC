const fetch = require('node-fetch');
const logger = require('../utils/logger')(__filename);

class HubSpotMigrationService {
  /**
   * Execute batch upsert to HubSpot
   * @param {string} accessToken - HubSpot API access token
   * @param {array} jobs - Array of migration jobs
   */
  async executeBatch(accessToken, jobs) {
    const results = {
      results: [],
      successfulRecords: [],
      failures: [],
      stats: { success: 0, failed: 0 }
    };

    try {
      for (const job of jobs) {
        const {
          targetObject,
          targetExtIdField,
          records: jobRecords,
          mappings,
          operationMode = 'upsert'
        } = job;

        logger.info(`Starting HubSpot migration to ${targetObject}`, {
          recordCount: jobRecords?.length || 0,
          operation: operationMode
        });

        // Build HubSpot batch payload
        const inputs = this.buildHubSpotPayload(
          jobRecords,
          mappings,
          targetExtIdField,
          operationMode
        );

        if (inputs.length === 0) {
          logger.warn(`No records to migrate for ${targetObject}`);
          continue;
        }

        // Send to HubSpot in batches (max 100 per request)
        const batchSize = 100;
        for (let i = 0; i < inputs.length; i += batchSize) {
          const batch = inputs.slice(i, i + batchSize);
          await this.sendBatchToHubSpot(
            accessToken,
            targetObject,
            batch,
            targetExtIdField,
            jobRecords,
            results
          );
        }
      }

      results.stats.success = results.successfulRecords.length;
      results.stats.failed = results.failures.length;

      logger.info('HubSpot migration completed', results.stats);
      return results;
    } catch (error) {
      logger.error('HubSpot batch migration error', { error: error.message });
      throw error;
    }
  }

  /**
   * Build payload for HubSpot Batch API
   */
  buildHubSpotPayload(records, mappings, extIdField, operation) {
    if (!records || records.length === 0) return [];

    return records.map((record, index) => {
      const properties = {};

      // Map source fields to target fields
      mappings.forEach(mapping => {
        const sourceField = mapping.sourceField;
        const targetField = mapping.targetField;

        if (record.hasOwnProperty(sourceField)) {
          let value = record[sourceField];

          // Apply type conversion
          if (mapping.type === 'boolean' && typeof value !== 'boolean') {
            value = String(value).toLowerCase() === 'true' ||
                   String(value).toLowerCase() === 'yes' ||
                   String(value) === '1';
          }

          if (value !== null && value !== undefined && value !== '') {
            properties[targetField] = String(value);
          }
        }
      });

      // For upsert, include external ID if provided
      if (operation === 'upsert' && extIdField && record[extIdField]) {
        return {
          idProperty: extIdField,
          properties: properties
        };
      }

      return { properties };
    });
  }

  /**
   * Send batch to HubSpot API
   */
  async sendBatchToHubSpot(accessToken, objectType, inputs, extIdField, originalRecords, results) {
    try {
      const url = `https://api.hubapi.com/crm/v3/objects/${objectType}/batch/upsert`;

      const payload = {
        inputs: inputs
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`HubSpot API error: ${response.status} - ${errorBody}`);
      }

      const data = await response.json();

      // Process results
      if (data.results && Array.isArray(data.results)) {
        data.results.forEach((result, index) => {
          if (result.errors && result.errors.length > 0) {
            results.failures.push({
              record: originalRecords[index],
              error: result.errors.map(e => e.message).join('; ')
            });
          } else {
            results.successfulRecords.push({
              HubSpotId: result.id,
              ...originalRecords[index]
            });
          }
        });
      }

      logger.info(`HubSpot batch processed: ${inputs.length} records`, {
        object: objectType,
        success: data.results?.filter(r => !r.errors || r.errors.length === 0).length || 0,
        failed: data.results?.filter(r => r.errors && r.errors.length > 0).length || 0
      });

    } catch (error) {
      logger.error('Error sending batch to HubSpot', {
        error: error.message,
        objectType,
        batchSize: inputs.length
      });

      // Mark all as failures
      inputs.forEach((input, index) => {
        results.failures.push({
          record: originalRecords[index],
          error: error.message
        });
      });
    }
  }

  /**
   * Fetch records from HubSpot
   */
  async fetchRecords(accessToken, objectType, query, limit = 100) {
    try {
      // Basic fetch without complex filtering for now
      // HubSpot's search API is limited on free tier
      const url = `https://api.hubapi.com/crm/v3/objects/${objectType}?limit=${limit}&properties=*`;

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`HubSpot API error: ${response.status}`);
      }

      const data = await response.json();
      const records = (data.results || []).map(item => ({
        id: item.id,
        ...item.properties
      }));

      logger.info(`Fetched ${records.length} records from HubSpot ${objectType}`);
      return records;
    } catch (error) {
      logger.error('Error fetching records from HubSpot', {
        error: error.message,
        objectType
      });
      throw error;
    }
  }

  /**
   * Map HubSpot field types to standard types
   */
  mapFieldType(hubspotType) {
    const typeMap = {
      'string': 'string',
      'number': 'number',
      'date': 'date',
      'datetime': 'datetime',
      'enumeration': 'picklist',
      'bool': 'boolean',
      'phone_number': 'phone',
      'email': 'email',
      'currency': 'currency'
    };

    return typeMap[hubspotType] || 'string';
  }
}

module.exports = new HubSpotMigrationService();
