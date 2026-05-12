const fs = require('fs');
const path = require('path');

class LogService {
  async saveMigrationLog(targetObject, records, results) {
    // 1. Create a "logs" directory if it doesn't exist
    const logsBaseDir = path.join(__dirname, '../logs');
    if (!fs.existsSync(logsBaseDir)) fs.mkdirSync(logsBaseDir);

    // 2. Create a date-wise folder (e.g., logs/2026-03-22)
    const dateFolder = new Date().toISOString().split('T')[0];
    const targetDir = path.join(logsBaseDir, dateFolder);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir);

    // 3. Merge original data with Salesforce results
    const detailedLogs = records.map((originalRow, index) => {
      const result = results[index];
      return {
        rowNumber: index + 1,
        status: result.success ? 'SUCCESS' : 'FAILED',
        salesforceId: result.id || null,
        errors: result.success ? [] : result.errors,
        originalData: originalRow // This shows which data failed
      };
    });

    // 4. Save the file with a timestamp
    const timestamp = new Date().getTime();
    const fileName = `${targetObject}_${timestamp}.json`;
    const filePath = path.join(targetDir, fileName);

    fs.writeFileSync(filePath, JSON.stringify(detailedLogs, null, 2));
    return filePath;
  }
}

module.exports = new LogService();