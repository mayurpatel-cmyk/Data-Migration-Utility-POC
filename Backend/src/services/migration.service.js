const logger = require('../utils/logger')(__filename);

class MigrationService {
  
  // 1: Dependency Sorter (Parents First)
  sortJobsByDependency(jobs) {
    const sorted = [];
    const visited = new Set();
    const visiting = new Set();

    function visit(job) {
      if (visited.has(job.targetObject)) return;
      if (visiting.has(job.targetObject)) {
        logger.warn(`Circular dependency detected involving ${job.targetObject}.`);
        return; 
      }

      visiting.add(job.targetObject);

      const dependencies = job.mappings
        .filter(m => m.type === 'reference' && m.referenceTo)
        .flatMap(m => m.referenceTo); 

      for (const dep of dependencies) {
        const parentJob = jobs.find(j => j.targetObject === dep);
        if (parentJob) visit(parentJob);
      }

      visiting.delete(job.targetObject);
      visited.add(job.targetObject);
      sorted.push(job);
    }

    jobs.forEach(job => visit(job));
    return sorted;
  }

  // 2: Data Cleanser (Dates, Booleans, Picklists)
  cleanseData(value, sfType) {
    if (value === undefined || value === null || value === '') return null;

    switch (sfType) {
      case 'boolean':
        const strVal = String(value).trim().toLowerCase();
        return ['true', '1', 'yes', 'y', 'active'].includes(strVal);

      case 'date':
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
        return String(value).trim();

      default:
        return value;
    }
  }

  //3: Payload Builder
  buildPayload(rawRecords, mappings, options = {}) {
    const { 
      skipSelfReferencing = false, 
      onlySelfReferencing = false, 
      targetObject = '', 
      targetExtIdField = '' 
    } = options;

    const payload = [];

    rawRecords.forEach((rawRow, originalIndex) => {
      const sfRecord = {};
      let hasPass2Data = false;
      
      if (onlySelfReferencing && targetExtIdField) {
        const primaryMapping = mappings.find(m => m.sfField === targetExtIdField);
        if (primaryMapping && rawRow[primaryMapping.csvField]) {
          sfRecord[targetExtIdField] = this.cleanseData(rawRow[primaryMapping.csvField], primaryMapping.type);
        }
      }

      Object.entries(rawRow).forEach(([csvKey, csvValue]) => {
        const cleanKey = csvKey.trim();
        const mappingMeta = mappings.find(m => m.csvField === cleanKey);
        
        if (!mappingMeta || !mappingMeta.sfField) return;

        const cleansedValue = this.cleanseData(csvValue, mappingMeta.type);
        if (cleansedValue === null) return;

        const isSelfRef = mappingMeta.type === 'reference' && 
                          mappingMeta.referenceTo && 
                          mappingMeta.referenceTo.includes(targetObject);

        if (skipSelfReferencing && isSelfRef) return; 
        if (onlySelfReferencing && !isSelfRef) return; 

        if (mappingMeta.type === 'reference' && mappingMeta.relationalExtIdField && mappingMeta.relationshipName) {
          const relationalKey = `${mappingMeta.relationshipName}.${mappingMeta.relationalExtIdField}`;
          sfRecord[relationalKey] = cleansedValue;
          if (onlySelfReferencing) hasPass2Data = true;
        } else {
          sfRecord[mappingMeta.sfField] = cleansedValue;
        }
      });

      if (!onlySelfReferencing || (onlySelfReferencing && hasPass2Data)) {
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
        // Extract operationMode (defaulting to upsert to support legacy calls)
        const { targetObject, targetExtIdField, records: rawJobRecords, mappings, operationMode = 'upsert' } = job;

        // SCENARIO 1: SIMPLE INSERT (No Ext ID Needed)
        if (operationMode === 'insert') {
          const insertPayload = this.buildPayload(rawJobRecords, mappings, { targetObject });
          if (insertPayload.length === 0) continue;

          logger.info(`Starting Bulk INSERT: ${insertPayload.length} records into ${targetObject}`);
          const insertRecords = insertPayload.map(p => p.sfRecord);
          
          // Execute standard Bulk Insert
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
        
        // SCENARIO 2: COMPLEX UPSERT (Requires Ext ID)
        else if (operationMode === 'upsert') {
          if (!targetExtIdField) throw new Error(`Job for ${targetObject} is missing targetExtIdField for Upsert.`);

          const hasSelfReferencing = mappings.some(m => 
            m.type === 'reference' && m.referenceTo && m.referenceTo.includes(targetObject)
          );

          if (hasSelfReferencing) {
            logger.info(`[${targetObject}] Detected Self-Referencing Lookup. Initiating Two-Pass Upsert.`);
            
            // --- PASS 1: Upsert main data ---
            const pass1Payload = this.buildPayload(rawJobRecords, mappings, { skipSelfReferencing: true, targetObject });
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

            // --- PASS 2: Update Relationships ---
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
            // --- STANDARD 1-PASS UPSERT ---
            const standardPayload = this.buildPayload(rawJobRecords, mappings, { targetObject });
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