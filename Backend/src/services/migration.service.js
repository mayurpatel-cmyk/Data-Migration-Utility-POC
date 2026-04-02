const logger = require('../utils/logger')(__filename);
const { STATE_MAP, COUNTRY_MAP, RECORD_TYPE_MAP } = require('../configs/mappings');

class MigrationService {

  // --- UPGRADED: Data Cleanser with Cross-CRM Source Translation ---
  cleanseData(value, sfType, fieldName, targetObject, sourceType = null) {
    if (value === undefined || value === null || value === '') return null;
    if (String(value).trim() === '#N/A') return '#N/A';

    let processedValue = value;

    // 1. SOURCE CRM PRE-PROCESSING
    // Fix  from the origin CRM before formatting for SF
    if (sourceType) {
      switch (sourceType.toLowerCase()) {
        case 'unix_timestamp':
          // Convert Unix seconds to standard JS Date object
          processedValue = new Date(Number(processedValue) * 1000);
          break;
        case 'unix_timestamp_ms':
          // Convert Unix milliseconds to JS Date object
          processedValue = new Date(Number(processedValue));
          break;
        case 'yes_no_string':
          // Convert explicit Yes/No strings to actual booleans
          processedValue = String(processedValue).trim().toLowerCase() === 'yes';
          break;
        case 'comma_separated_string':
          // Specifically for turning messy source arrays into SF Multi-picklists
          processedValue = String(processedValue).replace(/\|/g, ',');
          break;
        case 'html_text':
          // Strip HTML tags if moving to a standard SF text field
          if (sfType === 'string' || sfType === 'textarea') {
            processedValue = String(processedValue).replace(/<[^>]*>?/gm, '').trim();
          }
          break;
      }
    }

    // 2. SALESFORCE TARGET FORMATTING
    switch (sfType) {
      case 'boolean':
        const strVal = String(processedValue).trim().toLowerCase();
        return ['true', '1', 'yes', 'y', 'active'].includes(strVal);

      // --- NUMBERS ---
      case 'currency':
      case 'double':
      case 'percent':
      case 'int':
        if (typeof processedValue === 'number') return processedValue;
        // Remove commas, currency symbols, and spaces (e.g., "$ 1,234.56" -> "1234.56")
        const numericString = String(processedValue).replace(/[^0-9.-]+/g, '');
        const parsedNum = sfType === 'int' ? parseInt(numericString, 10) : parseFloat(numericString);
        return isNaN(parsedNum) ? null : parsedNum;

      // --- DATES ---
      case 'date':
      case 'datetime':
        if (typeof processedValue === 'number') {
          // Converts Excel serial number (e.g., 45565) to standard date
          const dateObj = new Date(Math.round((processedValue - 25569) * 86400 * 1000));
          return sfType === 'date' ? dateObj.toISOString().split('T')[0] : dateObj.toISOString();
        }
        const parsedDate = new Date(processedValue);
        if (!isNaN(parsedDate.getTime())) {
          return sfType === 'date' ? parsedDate.toISOString().split('T')[0] : parsedDate.toISOString();
        }
        return null; // Fallback for invalid dates so SF doesn't crash

      // --- Multi-Select Picklist Cleanser ---
      case 'multipicklist':
        return String(processedValue)
          .split(',')
          .map(item => item.trim())
          .filter(item => item.length > 0)
          .join(';');
    }

    // --- FALLTHROUGH FOR PICKLISTS, TEXTAREAS, AND REMAINING STRINGS ---
    if (['picklist', 'string', 'textarea'].includes(sfType)) {
      let cleanStr = String(processedValue).trim();

      // --- RECORD TYPE RESOLUTION ---
      if (fieldName === 'RecordTypeId' && targetObject) {
        const objectRecordTypes = RECORD_TYPE_MAP[targetObject];

        if (objectRecordTypes && objectRecordTypes[cleanStr]) {
          return objectRecordTypes[cleanStr];
        } else {
          logger.warn(`Unmapped Record Type "${cleanStr}" for ${targetObject}.`);
          return cleanStr;
        }
      }

      // --- Address Resolution ---
      if (fieldName) {
        const lowerField = fieldName.toLowerCase();
        const lowerVal = cleanStr.toLowerCase();

        if (lowerField.includes('country') && COUNTRY_MAP[lowerVal]) {
          return COUNTRY_MAP[lowerVal];
        }
        if ((lowerField.includes('state') || lowerField.includes('province')) && STATE_MAP[lowerVal]) {
          return STATE_MAP[lowerVal];
        }
      }

      // --- Truncation (Fallback) ---
      if (sfType === 'string' && cleanStr.length > 255) {
        logger.warn(`Truncating field [${fieldName || 'Unknown'}] - Exceeded 255 characters.`);
        cleanStr = cleanStr.substring(0, 255);
      }

      return cleanStr;
    }

    // Default catch-all
    return processedValue;
  }

  // 1: Dependency Sorter (Parents First)
  sortJobsByDependency(jobs) {
    const sorted = [];
    const pass3Jobs = [];
    const visited = new Set();
    const visiting = new Set();

    function visit(job) {
      if (visited.has(job.targetObject)) return;

      visiting.add(job.targetObject);

      const dependencies = job.mappings
        .filter(m => m.type === 'reference' && m.referenceTo)
        .flatMap(m => m.referenceTo);

      const deferReferencesTo = [];

      for (const dep of dependencies) {
        const parentJob = jobs.find(j => j.targetObject === dep);
        if (parentJob) {
          if (visiting.has(dep)) {
            logger.warn(`Circular dependency: ${job.targetObject} <-> ${dep}. Deferring ${dep} link to Pass 3.`);
            deferReferencesTo.push(dep);
          } else {
            visit(parentJob);
          }
        }
      }

      visiting.delete(job.targetObject);
      visited.add(job.targetObject);

      job.deferReferencesTo = deferReferencesTo;
      sorted.push(job);

      if (deferReferencesTo.length > 0) {
        pass3Jobs.push({
          ...job,
          isPass3Patch: true,
          onlyReferencesTo: deferReferencesTo
        });
      }
    }

    jobs.forEach(job => visit(job));
    return [...sorted, ...pass3Jobs];
  }

  // 2: Payload Builder
  buildPayload(rawRecords, mappings, options = {}) {
    const {
      skipSelfReferencing = false,
      onlySelfReferencing = false,
      excludeReferencesTo = [],
      onlyReferencesTo = [],
      targetObject = '',
      targetExtIdField = ''
    } = options;

    const payload = [];
    const isPatchMode = onlySelfReferencing || onlyReferencesTo.length > 0;

    rawRecords.forEach((rawRow, originalIndex) => {
      const sfRecord = {};
      let hasPatchData = false;

      mappings.forEach(mappingMeta => {
        if (!mappingMeta || !mappingMeta.sfField) return;

        const csvKey = mappingMeta.csvField;
        const csvValue = rawRow[csvKey];

        // 1. Skip Audit Fields in Patch Mode
        const isAuditField = ['CreatedDate', 'CreatedById', 'LastModifiedDate', 'LastModifiedById'].includes(mappingMeta.sfField);
        if (isPatchMode && isAuditField) return;

        // 2. Format Value using the new cleanseData method and sourceType!
        const valueToUse = this.cleanseData(
          csvValue,
          mappingMeta.type,
          mappingMeta.sfField,
          targetObject,
          mappingMeta.sourceType // Pulled from your mapping configuration
        );

        const isPrimaryExtId = mappingMeta.sfField === targetExtIdField;

        if (valueToUse === null && !isPrimaryExtId) return;

        // 3. Dependency & Reference Logic
        const isSelfRef = mappingMeta.type === 'reference' && mappingMeta.referenceTo && mappingMeta.referenceTo.includes(targetObject);
        const referencesOther = mappingMeta.type === 'reference' && mappingMeta.referenceTo ? mappingMeta.referenceTo : [];

        const isExcludedCross = excludeReferencesTo.some(obj => referencesOther.includes(obj));
        const isOnlyTargetCross = onlyReferencesTo.length > 0 && onlyReferencesTo.some(obj => referencesOther.includes(obj));

        if (skipSelfReferencing && isSelfRef) return;
        if (onlySelfReferencing && !isSelfRef) return;
        if (isExcludedCross) return;
        if (onlyReferencesTo.length > 0 && !isOnlyTargetCross) return;

        // 4. Relationship Name Resolution
        let relName = mappingMeta.relationshipName;
        if (!relName && mappingMeta.sfField) {
          if (mappingMeta.sfField.endsWith('Id')) {
            relName = mappingMeta.sfField.slice(0, -2);
          } else if (mappingMeta.sfField.endsWith('__c')) {
            relName = mappingMeta.sfField.replace('__c', '__r');
          }
        }

        // 5. Map to Salesforce Record Object
        if (mappingMeta.type === 'reference' && mappingMeta.relationalExtIdField && relName) {
          const relationalKey = `${relName}.${mappingMeta.relationalExtIdField}`;
          sfRecord[relationalKey] = valueToUse;
          if (isPatchMode) hasPatchData = true;
        } else {
          sfRecord[mappingMeta.sfField] = valueToUse;
        }
      });

      if (targetExtIdField && !sfRecord.hasOwnProperty(targetExtIdField)) {
        sfRecord[targetExtIdField] = null;
      }

      if (!isPatchMode || (isPatchMode && hasPatchData)) {
        payload.push({ originalIndex, sfRecord });
      }
    });

    return payload;
  }

  // 4: CORE EXECUTION 
  async executeUpsertBatch(conn, targetObjectOrJobs, records) {
    try {
      const rawJobs = Array.isArray(targetObjectOrJobs)
        ? targetObjectOrJobs
        : [{ targetObject: targetObjectOrJobs, records: records }];

      const migrationJobs = this.sortJobsByDependency(rawJobs);

      let totalSuccess = 0, totalFailed = 0;
      let allFailures = [], allSuccessfulRecords = [];

      for (const job of migrationJobs) {
        const { targetObject, targetExtIdField, records: rawJobRecords, mappings, operationMode = 'upsert', deferReferencesTo = [], isPass3Patch, onlyReferencesTo = [] } = job;

        if (isPass3Patch) {
          if (!targetExtIdField) {
            logger.error(`Cannot run Pass 3 Patch for ${targetObject} without an External ID.`);
            continue;
          }

          logger.info(`[${targetObject}] Starting Pass 3: Cross-Object Circular Patch (Linking to ${onlyReferencesTo.join(', ')})`);
          const patchPayload = this.buildPayload(rawJobRecords, mappings, { targetObject, targetExtIdField, onlyReferencesTo });
          if (patchPayload.length === 0) continue;

          try {
            const patchRecords = patchPayload.map(p => p.sfRecord);
            const patchResults = await conn.bulk.load(targetObject, "upsert", { extIdField: targetExtIdField }, patchRecords);

            patchResults.forEach((res, i) => {
              if (!res.success) {
                const originalIndex = patchPayload[i].originalIndex;
                const originalRecord = rawJobRecords[originalIndex];
                const errMsg = Array.isArray(res.errors) ? res.errors.map(e => typeof e === 'string' ? e : e.message).join(', ') : (res.error || 'Unknown Error');
                allFailures.push({ error: `[${targetObject} - Circular Link Failed] ${errMsg}`, record: originalRecord });
              }
            });
          } catch (err) {
            logger.error(`[${targetObject}] Pass 3 Fatal Error: ${err.message}`);
          }
          continue;
        }

        if (operationMode === 'insert') {
          const insertPayload = this.buildPayload(rawJobRecords, mappings, { targetObject, excludeReferencesTo: deferReferencesTo });
          if (insertPayload.length === 0) continue;

          try {
            logger.info(`Starting Bulk INSERT: ${insertPayload.length} records into ${targetObject}`);
            const insertRecords = insertPayload.map(p => p.sfRecord);

            const finalResults = await conn.bulk.load(targetObject, "insert", insertRecords);

            finalResults.forEach((res, i) => {
              const originalIndex = insertPayload[i].originalIndex;
              const originalRecord = rawJobRecords[originalIndex];
              if (res.success) {
                totalSuccess++;
                allSuccessfulRecords.push({ _TargetObject: targetObject, SalesforceId: res.id, Status: 'Created', ...originalRecord });
              } else {
                totalFailed++;
                const errMsg = Array.isArray(res.errors) ? res.errors.map(e => typeof e === 'string' ? e : e.message).join(', ') : (res.error || 'Unknown Error');
                allFailures.push({ error: `[${targetObject} Insert] ${errMsg}`, record: originalRecord });
              }
            });
          } catch (err) {
            logger.error(`[${targetObject}] Insert Fatal Error: ${err.message}`);
            insertPayload.forEach(p => allFailures.push({ error: `[${targetObject} Fatal Error] ${err.message}`, record: rawJobRecords[p.originalIndex] }));
            totalFailed += insertPayload.length;
          }
        }

        else if (operationMode === 'upsert') {
          if (!targetExtIdField) throw new Error(`Job for ${targetObject} is missing targetExtIdField for Upsert.`);

          const hasSelfReferencing = mappings.some(m => m.type === 'reference' && m.referenceTo && m.referenceTo.includes(targetObject));

          if (hasSelfReferencing) {
            logger.info(`[${targetObject}] Detected Self-Referencing Lookup. Initiating Two-Pass Upsert.`);

            const pass1Payload = this.buildPayload(rawJobRecords, mappings, { skipSelfReferencing: true, targetObject, targetExtIdField, excludeReferencesTo: deferReferencesTo });
            if (pass1Payload.length > 0) {
              try {
                const pass1Records = pass1Payload.map(p => p.sfRecord);
                const pass1Results = await conn.bulk.load(targetObject, "upsert", { extIdField: targetExtIdField }, pass1Records);

                pass1Results.forEach((res, i) => {
                  const originalIndex = pass1Payload[i].originalIndex;
                  const originalRecord = rawJobRecords[originalIndex];
                  if (res.success) {
                    totalSuccess++;
                    allSuccessfulRecords.push({ _TargetObject: targetObject, SalesforceId: res.id, Status: res.created ? 'Created' : 'Updated', ...originalRecord });
                  } else {
                    totalFailed++;
                    const errMsg = Array.isArray(res.errors) ? res.errors.map(e => typeof e === 'string' ? e : e.message).join(', ') : (res.error || 'Unknown Error');
                    allFailures.push({ error: `[${targetObject} - Base Data] ${errMsg}`, record: originalRecord });
                  }
                });
              } catch (err) {
                logger.error(`[${targetObject}] Pass 1 Fatal Error: ${err.message}`);
                pass1Payload.forEach(p => allFailures.push({ error: `[${targetObject} Pass 1 Fatal Error] ${err.message}`, record: rawJobRecords[p.originalIndex] }));
                totalFailed += pass1Payload.length;
              }
            }

            const pass2Payload = this.buildPayload(rawJobRecords, mappings, { onlySelfReferencing: true, targetObject, targetExtIdField });
            if (pass2Payload.length > 0) {
              try {
                const pass2Records = pass2Payload.map(p => p.sfRecord);
                const pass2Results = await conn.bulk.load(targetObject, "upsert", { extIdField: targetExtIdField }, pass2Records);

                pass2Results.forEach((res, i) => {
                  if (!res.success) {
                    const originalIndex = pass2Payload[i].originalIndex;
                    const originalRecord = rawJobRecords[originalIndex];
                    const errMsg = Array.isArray(res.errors) ? res.errors.map(e => typeof e === 'string' ? e : e.message).join(', ') : (res.error || 'Unknown Error');
                    allFailures.push({ error: `[${targetObject} - Relationship Link Failed] ${errMsg}`, record: originalRecord });
                  }
                });
              } catch (err) {
                logger.error(`[${targetObject}] Pass 2 Fatal Error: ${err.message}`);
              }
            }

          } else {
            const standardPayload = this.buildPayload(rawJobRecords, mappings, { targetObject, targetExtIdField, excludeReferencesTo: deferReferencesTo });
            if (standardPayload.length === 0) continue;

            try {
              logger.info(`Starting Bulk UPSERT: ${standardPayload.length} records into ${targetObject}`);
              const standardRecords = standardPayload.map(p => p.sfRecord);
              const finalResults = await conn.bulk.load(targetObject, "upsert", { extIdField: targetExtIdField }, standardRecords);

              finalResults.forEach((res, i) => {
                const originalIndex = standardPayload[i].originalIndex;
                const originalRecord = rawJobRecords[originalIndex];
                if (res.success) {
                  totalSuccess++;
                  allSuccessfulRecords.push({ _TargetObject: targetObject, SalesforceId: res.id, Status: res.created ? 'Created' : 'Updated', ...originalRecord });
                } else {
                  totalFailed++;
                  const errMsg = Array.isArray(res.errors) ? res.errors.map(e => typeof e === 'string' ? e : e.message).join(', ') : (res.error || 'Unknown Error');
                  allFailures.push({ error: `[${targetObject}] ${errMsg}`, record: originalRecord });
                }
              });
            } catch (err) {
              logger.error(`[${targetObject}] Standard Upsert Fatal Error: ${err.message}`);
              standardPayload.forEach(p => allFailures.push({ error: `[${targetObject} Fatal Error] ${err.message}`, record: rawJobRecords[p.originalIndex] }));
              totalFailed += standardPayload.length;
            }
          }
        }
      }

      return { stats: { success: totalSuccess, failed: totalFailed }, failures: allFailures, successfulRecords: allSuccessfulRecords };

    } catch (error) {
      logger.error(`Bulk Execution Error: ${error.message}`);
      throw error;
    }
  }
}

module.exports = new MigrationService();