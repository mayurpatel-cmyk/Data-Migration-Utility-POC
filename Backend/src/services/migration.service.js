const jsforce = require('jsforce');
const csv = require('fast-csv');
const fs = require('fs');

// Fetch all creatable SObjects
exports.getSalesforceObjects = async (conn) => {
     logger.info('Executing describeGlobal to fetch standard objects');
      
    const meta = await conn.describeGlobal();
    return meta.sobjects
        .filter(obj => obj.createable && obj.updateable)
        .map(obj => ({ label: obj.label, name: obj.name }));
};

// Fetch fields for a specific object
exports.getObjectFields = async (conn, objectName) => {
    logger.info(`Executing describe for object: ${objectName}`);
      
      const meta = await conn.sobject(objectName).describe();
    return meta.fields
        .filter(f => f.createable || f.updateable)
        .map(f => ({ label: f.label, name: f.name }));
};

// Migration logic with Mapping
exports.runBulkMigration = async (conn, file, metadata) => {
         logger.info('Executing describeGlobal to fetch standard objects');
      
    const meta = await conn.describeGlobal();
    const records = [];
    const mappings = metadata.mappings; // e.g., { "Zoho Email": "Email" }

    return new Promise((resolve, reject) => {
        fs.createReadStream(file.path)
            .pipe(csv.parse({ headers: true }))
            .on('data', (row) => {
                const transformedRow = {};
                // Loop through your mapping to build the Salesforce record
                Object.keys(mappings).forEach(zohoHeader => {
                    const sfField = mappings[zohoHeader];
                    if (sfField && row[zohoHeader]) {
                        transformedRow[sfField] = row[zohoHeader];
                    }
                });
                records.push(transformedRow);
            })
            .on('end', async () => {
                try {
                    const options = metadata.operation === 'upsert' ? { extIdField: metadata.externalId } : {};
                    const job = conn.bulk.load(metadata.objectName, metadata.operation, options, records);
                    
                    job.on("finish", (results) => {
                        fs.unlinkSync(file.path);
                        resolve(results);
                    });
                    job.on("error", (err) => reject(err));
                } catch (error) {
                    reject(error);
                }
            });
    });
};