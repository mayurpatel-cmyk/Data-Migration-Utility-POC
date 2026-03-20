const migrationService = require('../services/migration.service');

// 1. Fetch all Salesforce Objects
exports.getObjects = async (req, res) => {
    try {
        const sfConfig = {
            accessToken: req.user.accessToken,
            instanceUrl: req.user.sfUrl
        };
        const objects = await migrationService.getSalesforceObjects(sfConfig);
        res.status(200).json(objects);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// 2. Fetch Fields for a specific Object
exports.getFields = async (req, res) => {
    try {
        const sfConfig = {
            accessToken: req.user.accessToken,
            instanceUrl: req.user.sfUrl
        };
        const fields = await migrationService.getObjectFields(sfConfig, req.params.name);
        res.status(200).json(fields);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// 3. Perform Migration
exports.migrate = async (req, res) => {
    try {
        const sfConfig = {
            accessToken: req.user.accessToken,
            instanceUrl: req.user.sfUrl
        };
        const metadata = {
            operation: req.body.operation || 'insert',
            objectName: req.body.objectName,
            externalId: req.body.externalId,
            mappings: JSON.parse(req.body.mappings) // Parse the stringified JSON from Angular
        };

        const results = await migrationService.runBulkMigration(sfConfig, req.file, metadata);
        res.status(200).json({ success: true, data: results });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};