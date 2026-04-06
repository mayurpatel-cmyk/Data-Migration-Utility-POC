const logger = require('../utils/logger')(__filename);
const { STATE_MAP, COUNTRY_MAP, RECORD_TYPE_MAP } = require('../configs/mappings');

class MigrationService {

  // --- UPGRADED: Data Cleanser with Cross-CRM Source Translation ---
  cleanseData(value, sfType, fieldName, targetObject, sourceType = null) {
    if (value === undefined || value === null || value === '') return null;
    if (String(value).trim() === '#N/A') return '#N/A';

    let processedValue = value;

    // 1. SOURCE CRM PRE-PROCESSING
    if (sourceType) {
      switch (sourceType.toLowerCase()) {
        case 'unix_timestamp':
          processedValue = new Date(Number(processedValue) * 1000);
          break;
        case 'unix_timestamp_ms':
          processedValue = new Date(Number(processedValue));
          break;
        case 'yes_no_string':
          processedValue = String(processedValue).trim().toLowerCase() === 'yes';
          break;
        case 'comma_separated_string':
          processedValue = String(processedValue).replace(/\|/g, ',');
          break;
        case 'html_text':
          if (['string', 'textarea', 'email'].includes(sfType)) {
            processedValue = String(processedValue).replace(/<[^>]*>?/gm, '').trim();
          }
          break;
      }
    }

    // 2. SALESFORCE TARGET FORMATTING
    switch (sfType) {
      case 'boolean':
        const strVal = String(processedValue).trim().toLowerCase();
      if (['true', '1', 'yes', 'y', 'active'].includes(strVal)) {
      return true;
      }
      if (['false', '0', 'no', 'n', 'inactive'].includes(strVal)) {
      return false;
      }
      logger.warn(`Unrecognized boolean value: "${processedValue}" for field [${fieldName}]. Skipping.`);
      return null;

      case 'currency':
      case 'double':
      case 'percent':
      case 'int':
        if (typeof processedValue === 'number') return processedValue;
        const numericString = String(processedValue).replace(/[^0-9.-]+/g, '');
        const parsedNum = sfType === 'int' ? parseInt(numericString, 10) : parseFloat(numericString);
        return isNaN(parsedNum) ? null : parsedNum;

      case 'date':
      case 'datetime':
        if (typeof processedValue === 'number') {
          const dateObj = new Date(Math.round((processedValue - 25569) * 86400 * 1000));
          return sfType === 'date' ? dateObj.toISOString().split('T')[0] : dateObj.toISOString();
        }
        const parsedDate = new Date(processedValue);
        if (!isNaN(parsedDate.getTime())) {
          return sfType === 'date' ? parsedDate.toISOString().split('T')[0] : parsedDate.toISOString();
        }
        return null; 

      case 'time':
        if (processedValue instanceof Date) {
          return processedValue.toISOString().split('T')[1];
        }
        // If it's already a string like "14:30:00", return it cleaned up
        return String(processedValue).trim();

      case 'multipicklist':
        return String(processedValue)
          .split(',')
          .map(item => item.trim())
          .filter(item => item.length > 0)
          .join(';');

      case 'email':
        let emailStr = String(processedValue).trim().replace(/\s+/g, ''); // Remove spaces
        if (emailStr.length > 80) {
          logger.warn(`Truncating Email field [${fieldName}] - Exceeded 80 chars.`);
          emailStr = emailStr.substring(0, 80);
        }
        return emailStr;

      // NEW: Phone Validation & Truncation (Max 40 chars)
      case 'phone':
        let phoneStr = String(processedValue).trim();
        if (phoneStr.length > 40) {
          logger.warn(`Truncating Phone field [${fieldName}] - Exceeded 40 chars.`);
          phoneStr = phoneStr.substring(0, 40);
        }
        return phoneStr;

      // NEW: URL Formatting (Max 255 chars)
      case 'url':
        let urlStr = String(processedValue).trim();
        if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
          urlStr = 'https://' + urlStr; // SF often rejects URLs without protocols
        }
        if (urlStr.length > 255) {
          logger.warn(`Truncating URL field [${fieldName}] - Exceeded 255 chars.`);
          urlStr = urlStr.substring(0, 255);
        }
        return urlStr;

      case 'id':
      case 'reference':
        return String(processedValue).trim();
    }

    if (['picklist', 'string', 'textarea'].includes(sfType)) {
      let cleanStr = String(processedValue).trim();

      if (fieldName === 'RecordTypeId' && targetObject) {
        const objectRecordTypes = RECORD_TYPE_MAP[targetObject];
        if (objectRecordTypes && objectRecordTypes[cleanStr]) {
          return objectRecordTypes[cleanStr];
        } else {
          logger.warn(`Unmapped Record Type "${cleanStr}" for ${targetObject}.`);
          return cleanStr;
        }
      }

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

     if (sfType === 'string') {
        // Salesforce standard text fields CRASH if they contain line breaks
        cleanStr = cleanStr.replace(/[\r\n]+/g, ' '); 
        
        // Max 255 chars
        if (cleanStr.length > 255) {
          logger.warn(`Truncating String field [${fieldName || 'Unknown'}] - Exceeded 255 chars.`);
          cleanStr = cleanStr.substring(0, 255);
        }
      }

     if (sfType === 'textarea') {
        // Default Salesforce Long Text Area limit is often 32,768
        if (cleanStr.length > 32768) {
          logger.warn(`Truncating Textarea field [${fieldName || 'Unknown'}] - Exceeded 32,768 chars.`);
          cleanStr = cleanStr.substring(0, 32768);
        }
      }

      return cleanStr;
    }

    return processedValue;
  }

  // 1: Dependency Sorter
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

        const isAuditField = ['CreatedDate', 'CreatedById', 'LastModifiedDate', 'LastModifiedById'].includes(mappingMeta.sfField);
        if (isPatchMode && isAuditField) return;

        const valueToUse = this.cleanseData(
          csvValue,
          mappingMeta.type,
          mappingMeta.sfField,
          targetObject,
          mappingMeta.sourceType
        );

        const isPrimaryExtId = mappingMeta.sfField === targetExtIdField;
        if (valueToUse === null && !isPrimaryExtId) return;

        const isSelfRef = mappingMeta.type === 'reference' && mappingMeta.referenceTo && mappingMeta.referenceTo.includes(targetObject);
        const referencesOther = mappingMeta.type === 'reference' && mappingMeta.referenceTo ? mappingMeta.referenceTo : [];

        const isExcludedCross = excludeReferencesTo.some(obj => referencesOther.includes(obj));
        const isOnlyTargetCross = onlyReferencesTo.length > 0 && onlyReferencesTo.some(obj => referencesOther.includes(obj));

        if (skipSelfReferencing && isSelfRef) return;
        if (onlySelfReferencing && !isSelfRef) return;
        if (isExcludedCross) return;
        if (onlyReferencesTo.length > 0 && !isOnlyTargetCross) return;

        let relName = mappingMeta.relationshipName;
        if (!relName && mappingMeta.sfField) {
          if (mappingMeta.sfField.endsWith('Id')) {
            relName = mappingMeta.sfField.slice(0, -2);
          } else if (mappingMeta.sfField.endsWith('__c')) {
            relName = mappingMeta.sfField.replace('__c', '__r');
          }
        }

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

  // --- NEW: Data Chunker Helper ---
  chunkArray(array, size) {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
      result.push(array.slice(i, i + size));
    }
    return result;
  }

  // 4: CORE EXECUTION 
  async executeUpsertBatch(conn, targetObjectOrJobs, records) {
    // Global Polling Configuration (20 minutes timeout, 15 seconds interval)
    conn.bulk.pollTimeout = 1200000; 
    conn.bulk.pollInterval = 15000;

    try {
      const rawJobs = Array.isArray(targetObjectOrJobs)
        ? targetObjectOrJobs
        : [{ targetObject: targetObjectOrJobs, records: records }];

      const migrationJobs = this.sortJobsByDependency(rawJobs);

      let totalSuccess = 0, totalFailed = 0;
      let allFailures = [], allSuccessfulRecords = [];

      for (const job of migrationJobs) {
        const { 
            targetObject, 
            targetExtIdField, 
            records: rawJobRecords, 
            mappings, 
            batchSize = 10000, 
            operationMode = 'upsert', 
            deferReferencesTo = [], 
            isPass3Patch, 
            onlyReferencesTo = [],
            concurrencyMode = 'Parallel' // Support for 'Serial' mode
        } = job;

        const BATCH_SIZE = parseInt(batchSize, 10) || 10000;

        // --- DRY Error Handler for all catch blocks ---
        const handleBatchError = (err, chunk, stageName) => {
            const isTimeout = err.name === 'JobTimeoutError' || err.message.includes('polling time out');
            const prefix = isTimeout ? '[TIMEOUT]' : '[FATAL]';
            
            if (isTimeout) {
                logger.error(`[${targetObject} - ${stageName}] TIMEOUT: Job is still processing in Salesforce. Check Bulk Data Load Jobs in Setup.`);
            } else {
                logger.error(`[${targetObject} - ${stageName}] Fatal Error: ${err.message}`);
            }
            
            chunk.forEach(p => allFailures.push({ 
                error: `${prefix} ${err.message}`, 
                record: rawJobRecords[p.originalIndex] 
            }));
            totalFailed += chunk.length;
        };

        // SCENARIO: PASS 3 PATCH (Cross-Object Link)
        if (isPass3Patch) {
          if (!targetExtIdField) {
            logger.error(`Cannot run Pass 3 Patch for ${targetObject} without an External ID.`);
            continue;
          }

          logger.info(`[${targetObject}] Starting Pass 3: Cross-Object Circular Patch (Linking to ${onlyReferencesTo.join(', ')})`);
          const patchPayload = this.buildPayload(rawJobRecords, mappings, { targetObject, targetExtIdField, onlyReferencesTo });
          if (patchPayload.length === 0) continue;

          const payloadChunks = this.chunkArray(patchPayload, BATCH_SIZE);
          let chunkCounter = 1;

          for (const chunk of payloadChunks) {
            try {
              logger.info(`[${targetObject}] Pass 3 Batch ${chunkCounter}/${payloadChunks.length} (${chunk.length} records)`);
              const patchRecords = chunk.map(p => p.sfRecord);
              const patchResults = await conn.bulk.load(targetObject, "upsert", { extIdField: targetExtIdField, concurrencyMode }, patchRecords);

              patchResults.forEach((res, i) => {
                if (!res.success) {
                  const originalRecord = rawJobRecords[chunk[i].originalIndex];
                  const errMsg = Array.isArray(res.errors) ? res.errors.map(e => typeof e === 'string' ? e : e.message).join(', ') : (res.error || 'Unknown Error');
                  allFailures.push({ error: `[${targetObject} - Circular Link Failed] ${errMsg}`, record: originalRecord });
                }
              });
            } catch (err) {
                handleBatchError(err, chunk, `Pass 3 Batch ${chunkCounter}`);
            }
            chunkCounter++;
          }
          continue;
        }

        // SCENARIO 1: SIMPLE INSERT
        if (operationMode === 'insert') {
          const insertPayload = this.buildPayload(rawJobRecords, mappings, { targetObject, excludeReferencesTo: deferReferencesTo });
          if (insertPayload.length === 0) continue;

          const payloadChunks = this.chunkArray(insertPayload, BATCH_SIZE);
          let chunkCounter = 1;

          logger.info(`[${targetObject}] Starting Bulk INSERT: ${insertPayload.length} total records across ${payloadChunks.length} batches.`);

          for (const chunk of payloadChunks) {
            try {
              logger.info(`[${targetObject}] Insert Batch ${chunkCounter}/${payloadChunks.length} (${chunk.length} records)`);
              const insertRecords = chunk.map(p => p.sfRecord);
              const finalResults = await conn.bulk.load(targetObject, "insert", { concurrencyMode }, insertRecords);

              finalResults.forEach((res, i) => {
                const originalRecord = rawJobRecords[chunk[i].originalIndex];
                if (res.success) {
                  totalSuccess++;
                  allSuccessfulRecords.push({ _TargetObject: targetObject, SalesforceId: res.id, Status: 'Created', ...originalRecord });
                } else {
                  totalFailed++;
                  const errMsg = Array.isArray(res.errors) ? res.errors.map(e => typeof e === 'string' ? e : e.message).join(', ') : (res.error || 'Unknown Error');
                  allFailures.push({ error: `[${targetObject} Insert Failed] ${errMsg}`, record: originalRecord });
                }
              });
            } catch (err) {
                handleBatchError(err, chunk, `Insert Batch ${chunkCounter}`);
            }
            chunkCounter++;
          }
        }

        // SCENARIO 2: COMPLEX UPSERT
        else if (operationMode === 'upsert') {
          if (!targetExtIdField) throw new Error(`Job for ${targetObject} is missing targetExtIdField for Upsert.`);

          const hasSelfReferencing = mappings.some(m => m.type === 'reference' && m.referenceTo && m.referenceTo.includes(targetObject));

          if (hasSelfReferencing) {
            logger.info(`[${targetObject}] Detected Self-Referencing Lookup. Initiating Two-Pass Upsert.`);

            // PASS 1: Base Data
            const pass1Payload = this.buildPayload(rawJobRecords, mappings, { skipSelfReferencing: true, targetObject, targetExtIdField, excludeReferencesTo: deferReferencesTo });
            if (pass1Payload.length > 0) {
              const pass1Chunks = this.chunkArray(pass1Payload, BATCH_SIZE);
              let chunkCounter = 1;

              for (const chunk of pass1Chunks) {
                try {
                  logger.info(`[${targetObject}] Pass 1 Upsert Batch ${chunkCounter}/${pass1Chunks.length} (${chunk.length} records)`);
                  const pass1Records = chunk.map(p => p.sfRecord);
                  const pass1Results = await conn.bulk.load(targetObject, "upsert", { extIdField: targetExtIdField, concurrencyMode }, pass1Records);

                  pass1Results.forEach((res, i) => {
                    const originalRecord = rawJobRecords[chunk[i].originalIndex];
                    if (res.success) {
                      totalSuccess++;
                      allSuccessfulRecords.push({ _TargetObject: targetObject, SalesforceId: res.id, Status: res.created ? 'Created' : 'Updated', ...originalRecord });
                    } else {
                      totalFailed++;
                      const errMsg = Array.isArray(res.errors) ? res.errors.map(e => typeof e === 'string' ? e : e.message).join(', ') : (res.error || 'Unknown Error');
                      allFailures.push({ error: `[${targetObject} - Base Data Failed] ${errMsg}`, record: originalRecord });
                    }
                  });
                } catch (err) {
                    handleBatchError(err, chunk, `Pass 1 Batch ${chunkCounter}`);
                }
                chunkCounter++;
              }
            }

            // PASS 2: Self-Referencing Links
            const pass2Payload = this.buildPayload(rawJobRecords, mappings, { onlySelfReferencing: true, targetObject, targetExtIdField });
            if (pass2Payload.length > 0) {
              const pass2Chunks = this.chunkArray(pass2Payload, BATCH_SIZE);
              let chunkCounter = 1;

              for (const chunk of pass2Chunks) {
                try {
                  logger.info(`[${targetObject}] Pass 2 Upsert Batch ${chunkCounter}/${pass2Chunks.length} (${chunk.length} records)`);
                  const pass2Records = chunk.map(p => p.sfRecord);
                  const pass2Results = await conn.bulk.load(targetObject, "upsert", { extIdField: targetExtIdField, concurrencyMode }, pass2Records);

                  pass2Results.forEach((res, i) => {
                    if (!res.success) {
                      const originalRecord = rawJobRecords[chunk[i].originalIndex];
                      const errMsg = Array.isArray(res.errors) ? res.errors.map(e => typeof e === 'string' ? e : e.message).join(', ') : (res.error || 'Unknown Error');
                      allFailures.push({ error: `[${targetObject} - Relationship Link Failed] ${errMsg}`, record: originalRecord });
                    }
                  });
                } catch (err) {
                    handleBatchError(err, chunk, `Pass 2 Batch ${chunkCounter}`);
                }
                chunkCounter++;
              }
            }

          } else {
            // STANDARD 1-PASS UPSERT
            const standardPayload = this.buildPayload(rawJobRecords, mappings, { targetObject, targetExtIdField, excludeReferencesTo: deferReferencesTo });
            if (standardPayload.length === 0) continue;

            const standardChunks = this.chunkArray(standardPayload, BATCH_SIZE);
            let chunkCounter = 1;

            logger.info(`[${targetObject}] Starting Bulk UPSERT: ${standardPayload.length} total records across ${standardChunks.length} batches.`);

            for (const chunk of standardChunks) {
              try {
                logger.info(`[${targetObject}] Upsert Batch ${chunkCounter}/${standardChunks.length} (${chunk.length} records)`);
                const standardRecords = chunk.map(p => p.sfRecord);
                const finalResults = await conn.bulk.load(targetObject, "upsert", { extIdField: targetExtIdField, concurrencyMode }, standardRecords);

                finalResults.forEach((res, i) => {
                  const originalRecord = rawJobRecords[chunk[i].originalIndex];
                  if (res.success) {
                    totalSuccess++;
                    allSuccessfulRecords.push({ _TargetObject: targetObject, SalesforceId: res.id, Status: res.created ? 'Created' : 'Updated', ...originalRecord });
                  } else {
                    totalFailed++;
                    const errMsg = Array.isArray(res.errors) ? res.errors.map(e => typeof e === 'string' ? e : e.message).join(', ') : (res.error || 'Unknown Error');
                    allFailures.push({ error: `[${targetObject} Upsert Failed] ${errMsg}`, record: originalRecord });
                  }
                });
              } catch (err) {
                  handleBatchError(err, chunk, `Standard Upsert Batch ${chunkCounter}`);
              }
              chunkCounter++;
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