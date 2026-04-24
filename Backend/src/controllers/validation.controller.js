const logger = require('../utils/logger')(__filename);

exports.validateData = async (req, res) => {
  const email = req.headers['user-email'];
  const targetObject = req.body.targetObject;

  try {
    logger.info(`Sending ${req.body.records.length} records to Python Data Engine...`);

    // 1. DYNAMIC DESCRIBE API FETCH
    let sfRules = {};
    if (targetObject && req.sfConn) {
      try {
        const describeMeta = await req.sfConn.sobject(targetObject).describe();
        
        describeMeta.fields.forEach(field => {
          sfRules[field.name] = {
            type: field.type,
            length: field.length,
            precision: field.precision,
            scale: field.scale,
            referenceTo: field.referenceTo && field.referenceTo.length > 0 ? field.referenceTo : null,
            relationshipName: field.relationshipName,
            required: !field.nillable && !field.defaultedOnCreate && field.createable,
            unique: field.unique,
            externalId: field.externalId,
            idLookup: field.idLookup,
            createable: field.createable,
            updateable: field.updateable,
            calculated: field.calculated,
            autoNumber: field.autoNumber,
            // Grab active picklist values (lowercase for easy matching)
            restrictedPicklist: field.restrictedPicklist,
            picklistValues: field.picklistValues 
              ? field.picklistValues.filter(p => p.active).map(p => p.value.toLowerCase()) 
              : []
          };
        });
      } catch (describeErr) {
        logger.warn(`Could not fetch Describe API for ${targetObject}. Proceeding with default Python rules.`);
      }
    }

    // 2. Attach the SF rules to the payload for Python
    req.body.sfRules = sfRules;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);

    const response = await fetch('http://localhost:8000/api/python/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: controller.signal
    });

    clearTimeout(timeoutId); 

    if (!response.ok) throw new Error(`Python service status: ${response.status}`);
    const pythonData = await response.json();

    res.json({ success: true, message: `Validation finished!`, ...pythonData });

  } catch (error) {
    if (error.name === 'AbortError') {
      return res.status(504).json({ success: false, message: "Python Engine Timed Out." });
    }
    logger.error('Python Validation Gateway Error', { error: error.message });
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};