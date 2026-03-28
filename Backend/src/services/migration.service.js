const logger = require('../utils/logger')(__filename);
// IMPORT YOUR MAPS HERE (Adjust the path to match your folder structure)
const { COUNTRY_MAP, STATE_MAP,RECORD_TYPE_MAP } = require('../configs/mappings');

class MigrationService {

  // 1: Dependency Sorter (Parents First)
  sortJobsByDependency(jobs) {
    const sorted = [];
    const pass3Jobs = []; // Holds the deferred linking jobs
    const visited = new Set();
    const visiting = new Set();

    function visit(job) {
      if (visited.has(job.targetObject)) return;
      
      visiting.add(job.targetObject);

      const dependencies = job.mappings
        .filter(m => m.type === 'reference' && m.referenceTo)
        .flatMap(m => m.referenceTo); 

      // Track dependencies that cause a cycle so we can defer them
      const deferReferencesTo = [];

      for (const dep of dependencies) {
        const parentJob = jobs.find(j => j.targetObject === dep);
        if (parentJob) {
          if (visiting.has(dep)) {
            // CIRCULAR DEPENDENCY DETECTED (A <-> B)
            logger.warn(`Circular dependency: ${job.targetObject} <-> ${dep}. Deferring ${dep} link to Pass 3.`);
            deferReferencesTo.push(dep);
          } else {
            visit(parentJob);
          }
        }
      }

      visiting.delete(job.targetObject);
      visited.add(job.targetObject);
      
      // Store what to skip on the main job
      job.deferReferencesTo = deferReferencesTo;
      sorted.push(job);

      // If we deferred a relationship, schedule a Pass 3 Update for later
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

  // 2: Data Cleanser (Dates, Booleans, Picklists)
  cleanseData(value, sfType) {
    if (value === undefined || value === null || value === '') return null;
    if (String(value).trim() === '#N/A') return '#N/A';

    switch (sfType) {
      case 'boolean':
        const strVal = String(value).trim().toLowerCase();
        return ['true', '1', 'yes', 'y', 'active'].includes(strVal);

      case 'date':
      case 'currency':
      case 'double':
      case 'percent':
        
      case 'int':
        if (typeof value === 'number') return value;
        // Remove commas, currency symbols, and spaces (e.g., "$ 1,234.56" -> "1234.56")
        const numericString = String(value).replace(/[^0-9.-]+/g, '');
        const parsedNum = sfType === 'int' ? parseInt(numericString, 10) : parseFloat(numericString);
        return isNaN(parsedNum) ? null : parsedNum;

      case 'string':
        // Prevent SF "Data too large" errors (default standard is often 255)
        // Note: Ideally, pass the `length` property from your SF field metadata into this function.
        return String(value).trim().substring(0, 255);
      case 'datetime':
        if (typeof value === 'number') {
          const dateObj = new Date(Math.round((value - 25569) * 86400 * 1000));
          return sfType === 'date' ? dateObj.toISOString().split('T')[0] : dateObj.toISOString();
        }
        const parsedDate = new Date(value);
        if (!isNaN(parsedDate.getTime())) {
          return sfType === 'date' ? parsedDate.toISOString().split('T')[0] : parsedDate.toISOString();
        }
        return value;

      // --- NEW: Multi-Select Picklist Cleanser ---
      case 'multipicklist':
        // Takes "Apples,   Oranges , Bananas" 
        // Returns "Apples;Oranges;Bananas"
        return String(value)
          .split(',')
          .map(item => item.trim()) // Cleans the extra spaces off each item
          .filter(item => item.length > 0) // Removes empty items if there was a trailing comma
          .join(';');

      case 'picklist':
      case 'string':
      case 'textarea':
        let cleanStr = String(value).trim();

        // --- NEW: RECORD TYPE RESOLUTION ---
        // If the target field is exactly RecordTypeId, do the lookup
        if (fieldName === 'RecordTypeId' && targetObject) {
          const objectRecordTypes = RECORD_TYPE_MAP[targetObject];
          
          if (objectRecordTypes && objectRecordTypes[cleanStr]) {
            return objectRecordTypes[cleanStr];
          } else {
            logger.warn(`Unmapped Record Type "${cleanStr}" for ${targetObject}.`);
            // Optional: return a default ID here if you want to prevent failures
            return cleanStr; 
          }
        }

        // --- EXISTING: Address Resolution ---
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

        // --- EXISTING: Truncation ---
        if (sfType === 'string' && cleanStr.length > 255) {
          logger.warn(`Truncating field [${fieldName || 'Unknown'}] - Exceeded 255 characters.`);
          cleanStr = cleanStr.substring(0, 255);
        }

        return cleanStr;

      default:
        return value;
    }
  }

  //3: Payload Builder
 buildPayload(rawRecords, mappings, options = {}) {
    const { 
      skipSelfReferencing = false, 
      onlySelfReferencing = false, 
      excludeReferencesTo = [], // NEW: Hide these lookups in Pass 1
      onlyReferencesTo = [],    // NEW: Isolate these lookups in Pass 3
      targetObject = '', 
      targetExtIdField = '' 
    } = options;

    const payload = [];
    const isPatchMode = onlySelfReferencing || onlyReferencesTo.length > 0;

    rawRecords.forEach((rawRow, originalIndex) => {
      const sfRecord = {};
      let hasPatchData = false;
      
      // If we are patching, we MUST include the External ID so Salesforce knows what to update
      if (isPatchMode && targetExtIdField) {
        const primaryMapping = mappings.find(m => m.sfField === targetExtIdField);
        if (primaryMapping && rawRow[primaryMapping.csvField]) {
          sfRecord[targetExtIdField] = this.cleanseData(rawRow[primaryMapping.csvField], primaryMapping.type);
        }
      }

      Object.entries(rawRow).forEach(([csvKey, csvValue]) => {
        const cleanKey = csvKey.trim();
        const mappingMeta = mappings.find(m => m.csvField === cleanKey);
        const isAuditField = ['CreatedDate', 'CreatedById', 'LastModifiedDate', 'LastModifiedById'].includes(mappingMeta.sfField);
        
        if (!mappingMeta || !mappingMeta.sfField) return;

        if (isPatchMode && isAuditField) return; 

       const cleansedValue = this.cleanseData(csvValue, mappingMeta.type, mappingMeta.sfField, targetObject);
        if (cleansedValue === null) return;

        // Determine relationship targets
        const isSelfRef = mappingMeta.type === 'reference' && mappingMeta.referenceTo && mappingMeta.referenceTo.includes(targetObject);
        const referencesOther = mappingMeta.type === 'reference' && mappingMeta.referenceTo ? mappingMeta.referenceTo : [];
        
        const isExcludedCross = excludeReferencesTo.some(obj => referencesOther.includes(obj));
        const isOnlyTargetCross = onlyReferencesTo.length > 0 && onlyReferencesTo.some(obj => referencesOther.includes(obj));

        // Skip logic based on current Pass
        if (skipSelfReferencing && isSelfRef) return; 
        if (onlySelfReferencing && !isSelfRef) return; 
        if (isExcludedCross) return; // Skip deferred lookups in Pass 1
        if (onlyReferencesTo.length > 0 && !isOnlyTargetCross) return; // Skip everything else in Pass 3

        if (mappingMeta.type === 'reference' && mappingMeta.relationalExtIdField && mappingMeta.relationshipName) {
          const relationalKey = `${mappingMeta.relationshipName}.${mappingMeta.relationalExtIdField}`;
          sfRecord[relationalKey] = cleansedValue;
          if (isPatchMode) hasPatchData = true;
        } else {
          sfRecord[mappingMeta.sfField] = cleansedValue;
        }
      });

      // Only add to payload if it's a normal run, or if it's a patch run that actually has relational data
      if (!isPatchMode || (isPatchMode && hasPatchData)) {
        payload.push({ originalIndex, sfRecord });
      }
    });

    return payload;
  }
  // CORE EXECUTION 
 async executeUpsertBatch(conn, targetObjectOrJobs, records) {
    try {
      const rawJobs = Array.isArray(targetObjectOrJobs) 
        ? targetObjectOrJobs 
        : [{ targetObject: targetObjectOrJobs, records: records }];

      const migrationJobs = this.sortJobsByDependency(rawJobs);

      let totalSuccess = 0, totalFailed = 0;
      let allFailures = [], allSuccessfulRecords = [];

      for (const job of migrationJobs) {
        // Destructure our new Pass 3 variables
        const { targetObject, targetExtIdField, records: rawJobRecords, mappings, operationMode = 'upsert', deferReferencesTo = [], isPass3Patch, onlyReferencesTo = [] } = job;

        // --- NEW SCENARIO: PASS 3 PATCH (Cross-Object Link) ---
        if (isPass3Patch) {
          if (!targetExtIdField) {
             logger.error(`Cannot run Pass 3 Patch for ${targetObject} without an External ID.`);
             continue; 
          }

          logger.info(`[${targetObject}] Starting Pass 3: Cross-Object Circular Patch (Linking to ${onlyReferencesTo.join(', ')})`);
          const patchPayload = this.buildPayload(rawJobRecords, mappings, { targetObject, targetExtIdField, onlyReferencesTo });
          if (patchPayload.length === 0) continue;

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
          continue; // Skip the rest of the loop for this specific job
        }

        // SCENARIO 1: SIMPLE INSERT
        if (operationMode === 'insert') {
          // Pass excludeReferencesTo down so we don't accidentally try to link to an object that doesn't exist yet
          const insertPayload = this.buildPayload(rawJobRecords, mappings, { targetObject, excludeReferencesTo: deferReferencesTo });
          if (insertPayload.length === 0) continue;

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
        } 
        
        // SCENARIO 2: COMPLEX UPSERT
        else if (operationMode === 'upsert') {
          if (!targetExtIdField) throw new Error(`Job for ${targetObject} is missing targetExtIdField for Upsert.`);

          const hasSelfReferencing = mappings.some(m => m.type === 'reference' && m.referenceTo && m.referenceTo.includes(targetObject));

          if (hasSelfReferencing) {
            logger.info(`[${targetObject}] Detected Self-Referencing Lookup. Initiating Two-Pass Upsert.`);
            
            // PASS 1: Base Data (Also skipping cross-object deferred lookups)
            const pass1Payload = this.buildPayload(rawJobRecords, mappings, { skipSelfReferencing: true, targetObject, excludeReferencesTo: deferReferencesTo });
            if (pass1Payload.length > 0) {
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
            }

            // PASS 2: Self-Referencing Links
            const pass2Payload = this.buildPayload(rawJobRecords, mappings, { onlySelfReferencing: true, targetObject, targetExtIdField });
            if (pass2Payload.length > 0) {
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
            }

          } else {
            // STANDARD 1-PASS UPSERT (Skipping deferred cross-object lookups)
            const standardPayload = this.buildPayload(rawJobRecords, mappings, { targetObject, excludeReferencesTo: deferReferencesTo });
            if (standardPayload.length === 0) continue;

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