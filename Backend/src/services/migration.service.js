const logger = require('../utils/logger')(__filename);
// IMPORT YOUR MAPS HERE (Adjust the path to match your folder structure)
//const { COUNTRY_MAP, STATE_MAP, RECORD_TYPE_MAP } = require('../configs/mappings');

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
  cleanseData(value, sfType, fieldName, targetObject) {
    if (value === undefined || value === null || value === '') return null;
    
    // Kept your commented code intact in case you want to use it later
    /*
    if (String(value).trim() === '#N/A') return '#N/A';
    switch (sfType) {
      case 'boolean':
        // ... boolean logic ...
      default:
        return value;
    }
    */
  }

  // 3: Payload Builder
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
      
      // MUST iterate over MAPPINGS, not rawRow, to catch completely empty Excel cells
      mappings.forEach(mappingMeta => {
        if (!mappingMeta || !mappingMeta.sfField) return;
  
        const csvKey = mappingMeta.csvField;
        const csvValue = rawRow[csvKey];
  
        // 1. Skip Audit Fields in Patch Mode
        const isAuditField = ['CreatedDate', 'CreatedById', 'LastModifiedDate', 'LastModifiedById'].includes(mappingMeta.sfField);
        if (isPatchMode && isAuditField) return; 
  
        // 2. Format Value (MUST BE 'let' so we can format dates below!)
        let valueToUse = (csvValue === undefined || csvValue === '') ? null : csvValue;
        
        // --- EXCEL DATE FORMATTING ---
        if (valueToUse !== null && (mappingMeta.type === 'date' || mappingMeta.type === 'datetime')) {
          if (typeof valueToUse === 'number') {
            const dateObj = new Date(Math.round((valueToUse - 25569) * 86400 * 1000));
            valueToUse = mappingMeta.type === 'date' ? dateObj.toISOString().split('T')[0] : dateObj.toISOString();
          } else if (typeof valueToUse === 'string') {
            const parsedDate = new Date(valueToUse);
            if (!isNaN(parsedDate.getTime())) {
              valueToUse = mappingMeta.type === 'date' ? parsedDate.toISOString().split('T')[0] : parsedDate.toISOString();
            }
          }
        }
        // -----------------------------

        // Check if this field is our primary Upsert Key
        const isPrimaryExtId = mappingMeta.sfField === targetExtIdField;
  
        // Drop the field to save payload size ONLY if it's null AND not our Upsert Key
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
  
      // Failsafe: Force the Upsert Key into the payload if it's completely missing
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