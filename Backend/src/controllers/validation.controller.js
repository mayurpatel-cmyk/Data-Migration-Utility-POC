const logger = require('../utils/logger')(__filename);
const FormData = require('form-data');
const fetch = require('node-fetch'); // or native fetch if Node 18+
const fs = require('fs'); // <--- ADDED: Required to read and delete physical files

// 1. ROUTE: Proxy for Header Extraction
exports.extractHeaders = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const form = new FormData();
    // FIXED: Stream directly from the hard drive instead of RAM
    form.append('file', fs.createReadStream(req.file.path), { filename: req.file.originalname });

    const response = await fetch('http://localhost:8000/api/python/extract-headers', {
      method: 'POST',
      body: form,
      headers: form.getHeaders() // Crucial for multipart forwarding in Node
    });

    if (!response.ok) throw new Error(`Python error: ${response.status}`);
    
    const data = await response.json();
    res.json(data);
  } catch (error) {
    logger.error('Extract Headers Gateway Error', { error: error.message });
    res.status(500).json({ error: error.message });
  } finally {
    // FIXED: Always delete the temporary file after we are done
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
};

// 2. ROUTE: Validate Data
exports.validateData = async (req, res) => {
  try {
    if (!req.file || !req.body.config) {
      return res.status(400).json({ message: "File and config are required." });
    }

    // Angular sent config as a JSON string inside the form data
    const config = JSON.parse(req.body.config);
    const targetObject = config.targetObject;

    logger.info(`Validating ${targetObject} file via Python Engine...`);

    // DYNAMIC DESCRIBE API FETCH
    let sfRules = {};
    if (targetObject && req.sfConn) {
      try {
        const describeMeta = await req.sfConn.sobject(targetObject).describe();
        describeMeta.fields.forEach(field => {
          sfRules[field.name] = {
            type: field.type,
            length: field.length,
            required: !field.nillable && !field.defaultedOnCreate && field.createable,
            unique: field.unique,
            externalId: field.externalId,
            createable: field.createable,
            updateable: field.updateable,
            calculated: field.calculated,
            autoNumber: field.autoNumber,
            controllerName: field.controllerName,
            precision: field.precision,
            scale: field.scale,
            referenceTo: field.referenceTo,
            dependentValues: buildDependentPicklistMap(field, describeMeta.fields),
            restrictedPicklist: field.restrictedPicklist,
            picklistValues: field.picklistValues 
              ? field.picklistValues.filter(p => p.active).map(p => p.value.toLowerCase()) 
              : []
          };
        });
      } catch (describeErr) {
        logger.warn(`Could not fetch Describe API for ${targetObject}.`);
      }
    }

    // Attach SF rules to the config object
    config.sfRules = sfRules;

    // Reconstruct FormData for Python
    const form = new FormData();
    // FIXED: Stream directly from the hard drive instead of RAM
    form.append('file', fs.createReadStream(req.file.path), { filename: req.file.originalname });
    form.append('config', JSON.stringify(config));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 min timeout

    const response = await fetch('http://localhost:8000/api/python/validate', {
      method: 'POST',
      body: form,
      headers: form.getHeaders(), // Set proper boundary headers
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
       const errData = await response.text();
       throw new Error(`Python service failed: ${errData}`);
    }

    const pythonData = await response.json();
    res.json({ success: true, message: `Validation finished!`, ...pythonData });

  } catch (error) {
    if (error.name === 'AbortError') {
      return res.status(504).json({ success: false, message: "Python Engine Timed Out." });
    }
    logger.error('Python Validation Gateway Error', { error: error.message });
    res.status(500).json({ success: false, message: error.message });
  } finally {
    // FIXED: Always delete the temporary file after we are done
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
};

// 3. ROUTE: Revalidate Data (JSON Proxy)
exports.revalidateData = async (req, res) => {
  try {
    const payload = req.body;
    const targetObject = payload.targetObject;

    if (!targetObject) {
      return res.status(400).json({ message: "targetObject is required in the payload." });
    }

    logger.info(`Re-validating ${targetObject} records via Python Engine...`);

    // DYNAMIC DESCRIBE API FETCH (Needed again so Python knows the rules for the edited rows)
    let sfRules = {};
    if (req.sfConn) {
      try {
        const describeMeta = await req.sfConn.sobject(targetObject).describe();
        describeMeta.fields.forEach(field => {
          sfRules[field.name] = {
            type: field.type,
            length: field.length,
            required: !field.nillable && !field.defaultedOnCreate && field.createable,
            unique: field.unique,
            externalId: field.externalId,
            createable: field.createable,
            updateable: field.updateable,
            calculated: field.calculated,
            autoNumber: field.autoNumber,
            controllerName: field.controllerName,
            dependentValues: buildDependentPicklistMap(field, describeMeta.fields),
            restrictedPicklist: field.restrictedPicklist,
            picklistValues: field.picklistValues 
              ? field.picklistValues.filter(p => p.active).map(p => p.value.toLowerCase()) 
              : []
          };
        });
      } catch (describeErr) {
        logger.warn(`Could not fetch Describe API for ${targetObject}.`);
      }
    }

    // Attach SF rules to the payload
    payload.sfRules = sfRules;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 1 min timeout for JSON

    const response = await fetch('http://localhost:8000/api/python/revalidate', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' }, // No FormData here, just JSON
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
       const errData = await response.text();
       throw new Error(`Python service failed: ${errData}`);
    }

    const pythonData = await response.json();
    res.json({ success: true, message: `Re-validation finished!`, ...pythonData });

  } catch (error) {
    if (error.name === 'AbortError') {
      return res.status(504).json({ success: false, message: "Python Engine Timed Out." });
    }
    logger.error('Python Revalidation Gateway Error', { error: error.message });
    res.status(500).json({ success: false, message: error.message });
  }
};