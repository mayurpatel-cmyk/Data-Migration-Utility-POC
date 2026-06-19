const fetch = require('node-fetch');
const logger = require('../utils/logger')(__filename);

class ZohoMigrationService {
  /**
   * Execute batch upsert to Zoho CRM
   * @param {string} accessToken - Zoho API access token
   * @param {string} apiDomain - Zoho API domain
   * @param {array} jobs - Array of migration jobs
   */
  async executeBatch(accessToken, apiDomain, jobs) {
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
          records: jobRecords,
          mappings,
          operationMode = 'upsert',
          targetExtIdField
        } = job;

        logger.info(`Starting Zoho migration to ${targetObject}`, {
          recordCount: jobRecords?.length || 0,
          operation: operationMode
        });

        // Build Zoho batch payload
        const data = this.buildZohoPayload(
          jobRecords,
          mappings,
          operationMode,
          targetExtIdField
        );

        if (data.length === 0) {
          logger.warn(`No records to migrate for ${targetObject}`);
          continue;
        }

        // Send to Zoho
        await this.sendBatchToZoho(
          accessToken,
          apiDomain,
          targetObject,
          data,
          jobRecords,
          results
        );
      }

      results.stats.success = results.successfulRecords.length;
      results.stats.failed = results.failures.length;

      logger.info('Zoho migration completed', results.stats);
      return results;
    } catch (error) {
      logger.error('Zoho batch migration error', { error: error.message });
      throw error;
    }
  }

  /**
   * Build payload for Zoho Batch API
   */
  buildZohoPayload(records, mappings, operation, extIdField) {
    if (!records || records.length === 0) return [];

    return records.map((record, index) => {
      const payload = {};

      // Map source fields to target fields
      mappings.forEach(mapping => {
        const sourceField = mapping.sourceField;
        const targetField = mapping.targetField;

        if (record.hasOwnProperty(sourceField)) {
          let value = record[sourceField];

          if (value !== null && value !== undefined && value !== '') {
            // Zoho expects specific field formatting
            if (mapping.type === 'boolean') {
              value = String(value).toLowerCase() === 'true' ||
                     String(value).toLowerCase() === 'yes' ||
                     String(value) === '1' ? true : false;
            }

            payload[targetField] = value;
          }
        }
      });

      // For upsert with external ID
      if (operation === 'upsert' && extIdField && record[extIdField]) {
        payload[extIdField] = record[extIdField];
      }

      return payload;
    });
  }

  /**
   * Send batch to Zoho API
   */
  async sendBatchToZoho(accessToken, apiDomain, objectType, data, originalRecords, results) {
    try {
      const url = `${apiDomain}/crm/v6/${this.objectTypeToZohoModule(objectType)}/upsert`;

      const payload = {
        data: data,
        duplicate_check_fields: ['Email']  // Optional: specify dedup fields
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Zoho-oauthtoken ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Zoho API error: ${response.status} - ${errorBody}`);
      }

      const responseData = await response.json();

      // Process results
      if (responseData.data && Array.isArray(responseData.data)) {
        responseData.data.forEach((result, index) => {
          if (result.code === 1) {
            // Success
            results.successfulRecords.push({
              ZohoId: result.details.id,
              ...originalRecords[index]
            });
          } else {
            // Failure
            results.failures.push({
              record: originalRecords[index],
              error: result.message || 'Unknown error'
            });
          }
        });
      }

      logger.info(`Zoho batch processed for ${objectType}`, {
        success: responseData.data?.filter(r => r.code === 1).length || 0,
        failed: responseData.data?.filter(r => r.code !== 1).length || 0
      });

    } catch (error) {
      logger.error('Error sending batch to Zoho', {
        error: error.message,
        objectType,
        batchSize: data.length
      });

      // Mark all as failures
      data.forEach((item, index) => {
        results.failures.push({
          record: originalRecords[index],
          error: error.message
        });
      });
    }
  }

  /**
   * Fetch records from Zoho CRM
   */
  async fetchRecords(accessToken, apiDomain, moduleType, query, limit = 100) {
    try {
      const module = this.objectTypeToZohoModule(moduleType);
      let url = `${apiDomain}/crm/v6/${module}?fields=*&per_page=${limit}`;

      // Add COQL query if provided
      if (query) {
        url = `${apiDomain}/crm/v6/bulk/read`;
      }

      const response = await fetch(url, {
        method: query ? 'POST' : 'GET',
        headers: {
          'Authorization': `Zoho-oauthtoken ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: query ? JSON.stringify({ query }) : undefined
      });

      if (!response.ok) {
        throw new Error(`Zoho API error: ${response.status}`);
      }

      const data = await response.json();
      const records = data.data || [];

      logger.info(`Fetched ${records.length} records from Zoho ${moduleType}`);
      return records;
    } catch (error) {
      logger.error('Error fetching records from Zoho', {
        error: error.message,
        moduleType
      });
      throw error;
    }
  }

  /**
   * Convert object type to Zoho module name
   */
  objectTypeToZohoModule(objectType) {
    const mapping = {
      'contacts': 'Contacts',
      'companies': 'Accounts',
      'deals': 'Deals',
      'tickets': 'Tickets',
      'contact': 'Contacts',
      'account': 'Accounts',
      'deal': 'Deals',
      'ticket': 'Tickets'
    };

    return mapping[objectType.toLowerCase()] || objectType;
  }
}

module.exports = new ZohoMigrationService();
