const logger = require('../utils/logger')(__filename);
const { STATE_MAP, COUNTRY_MAP } = require('../configs/mappings');

class ValidationService {
  
  /**
   * Validates and cleans a batch of records against Salesforce metadata rules.
   * @param {Array} records - Raw JSON data from CSV/Excel
   * @param {Array} mappings - Array of objects mapping CSV columns to SF Fields + Types
   * @param {String} dedupeKey - The CSV column name to check for duplicates
   */
  validateBatch(records, mappings, dedupeKey) {
    const validRecords = [];
    const invalidRecords = [];
    const seenKeys = new Set();
    let duplicateCount = 0;

    records.forEach((row, index) => {
      let isRowValid = true;
      const rowErrors = [];
      const cleanRow = { ...row }; // Clone row for cleaning

      // 1. Duplicate Check
      if (dedupeKey && row[dedupeKey]) {
        const keyVal = String(row[dedupeKey]).trim().toLowerCase();
        if (seenKeys.has(keyVal)) {
          isRowValid = false;
          duplicateCount++;
          rowErrors.push(`Duplicate detected based on key: ${dedupeKey} (${keyVal})`);
        } else {
          seenKeys.add(keyVal);
        }
      }

      // 2. Field-level Validation & Cleanup
      mappings.forEach(mapping => {
        if (!mapping.csvField || !mapping.sfField) return;

        const csvKey = mapping.csvField;
        const rawValue = row[csvKey];
        const sfType = mapping.type; // e.g., 'email', 'boolean', 'string', 'date'

        // Skip empty values unless required (assuming you handle required logic separately or add it here)
        if (rawValue === undefined || rawValue === null || rawValue === '') return;

        try {
          const processedValue = this.cleanseAndValidateField(rawValue, sfType, mapping.sfField);
          if (processedValue.error) {
            isRowValid = false;
            rowErrors.push(`Column [${csvKey}]: ${processedValue.error}`);
          } else {
            // Apply cleaned data back to the row
            cleanRow[csvKey] = processedValue.value;
          }
        } catch (err) {
          isRowValid = false;
          rowErrors.push(`Column [${csvKey}]: Unexpected error - ${err.message}`);
        }
      });

      // 3. Routing Row
      if (isRowValid) {
        validRecords.push(cleanRow);
      } else {
        invalidRecords.push({ originalRow: row, errors: rowErrors.join(' | '), rowNumber: index + 2 });
      }
    });

    return {
      stats: {
        total: records.length,
        valid: validRecords.length,
        invalid: invalidRecords.length,
        duplicates: duplicateCount
      },
      validRecords,
      invalidRecords
    };
  }

  cleanseAndValidateField(value, sfType, fieldName) {
    let cleanVal = String(value).trim();

    switch (sfType) {
      case 'boolean':
        const lowerVal = cleanVal.toLowerCase();
        if (['true', '1', 'yes', 'y', 'active'].includes(lowerVal)) return { value: 'TRUE' };
        if (['false', '0', 'no', 'n', 'inactive'].includes(lowerVal)) return { value: 'FALSE' };
        return { error: `Invalid boolean format: "${value}". Use TRUE/FALSE or Yes/No.` };

      case 'email':
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(cleanVal)) return { error: `Invalid email format: "${value}"` };
        if (cleanVal.length > 80) return { error: `Email exceeds 80 characters.` };
        return { value: cleanVal.replace(/\s+/g, '') }; // Strip spaces

      case 'url':
        if (!cleanVal.startsWith('http://') && !cleanVal.startsWith('https://')) {
          cleanVal = 'https://' + cleanVal;
        }
        if (cleanVal.length > 255) return { error: `URL exceeds 255 characters.` };
        return { value: cleanVal };

      case 'date':
      case 'datetime':
        const parsedDate = new Date(value);
        if (isNaN(parsedDate.getTime())) return { error: `Invalid Date format: "${value}"` };
        return { value: sfType === 'date' ? parsedDate.toISOString().split('T')[0] : parsedDate.toISOString() };

      case 'string':
      case 'textarea':
      case 'picklist':
        // State/Country cleanup matching your migration service
        const lowerField = (fieldName || '').toLowerCase();
        if (lowerField.includes('country') && COUNTRY_MAP[cleanVal.toLowerCase()]) {
          cleanVal = COUNTRY_MAP[cleanVal.toLowerCase()];
        }
        if ((lowerField.includes('state') || lowerField.includes('province')) && STATE_MAP[cleanVal.toLowerCase()]) {
          cleanVal = STATE_MAP[cleanVal.toLowerCase()];
        }

        if (sfType === 'string' && cleanVal.length > 255) {
           return { value: cleanVal.substring(0, 255) }; // Auto-truncate string
        }
        return { value: cleanVal };

      default:
        return { value: cleanVal };
    }
  }
}

module.exports = new ValidationService();