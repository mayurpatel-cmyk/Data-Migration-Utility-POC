const fetch = require('node-fetch');
const logger = require('../utils/logger')(__filename);

// HubSpot Free-tier objects
const HUBSPOT_OBJECTS = ['contacts', 'companies', 'deals', 'tickets'];

exports.getAllObjects = async (req, res) => {
  const token = req.headers['hubspot-access-token'];
  const email = req.headers['user-email'];

  try {
    if (!token) {
      logger.warn('Failed to fetch HubSpot objects: No access token', { userEmail: email });
      return res.status(401).json({ success: false, message: 'No HubSpot access token provided.' });
    }

    logger.info('Fetching all HubSpot objects', { userEmail: email });

    const objects = HUBSPOT_OBJECTS.map(obj => ({
      name: obj,
      label: obj.charAt(0).toUpperCase() + obj.slice(1)
    }));

    logger.info('Successfully fetched HubSpot objects', {
      userEmail: email,
      objectCount: objects.length
    });

    res.json({ success: true, data: objects });
  } catch (error) {
    logger.error('Error fetching HubSpot objects', {
      error: error.message,
      stack: error.stack,
      userEmail: email
    });
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getObjectFields = async (req, res) => {
  const { objectName } = req.params;
  const token = req.headers['hubspot-access-token'];
  const email = req.headers['user-email'];

  try {
    if (!token) {
      logger.warn('Failed to fetch HubSpot fields: No access token', { userEmail: email });
      return res.status(401).json({ success: false, message: 'No HubSpot access token provided.' });
    }

    logger.info(`Fetching fields for HubSpot object: ${objectName}`, { userEmail: email });

    // Validate object name
    if (!HUBSPOT_OBJECTS.includes(objectName)) {
      return res.status(400).json({
        success: false,
        error: `Invalid object name: ${objectName}. Supported objects: ${HUBSPOT_OBJECTS.join(', ')}`
      });
    }

    // Fetch field schema from HubSpot CRM API
    const url = `https://api.hubapi.com/crm/v3/objects/${objectName}/model`;
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error(`HubSpot API error for object ${objectName}`, {
        status: response.status,
        body: errorBody
      });
      throw new Error(`HubSpot API error: ${response.status} - ${errorBody}`);
    }

    const data = await response.json();

    // Extract field information from HubSpot model
    const fields = (data.properties || []).map(prop => ({
      name: prop.name,
      label: prop.label,
      type: mapHubSpotFieldType(prop.type),
      isRequired: prop.required || false,
      referenceTo: prop.referencedObjectType ? [prop.referencedObjectType] : null,
      fieldType: prop.type
    }));

    logger.info(`Successfully fetched fields for HubSpot object: ${objectName}`, {
      userEmail: email,
      fieldCount: fields.length
    });

    res.json({ success: true, object: objectName, fields });
  } catch (error) {
    logger.error(`Error fetching fields for HubSpot object: ${objectName}`, {
      error: error.message,
      stack: error.stack,
      objectName: objectName,
      userEmail: email
    });
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getUserInfo = async (req, res) => {
  const token = req.headers['hubspot-access-token'];
  const email = req.headers['user-email'];

  try {
    if (!token) {
      logger.warn('Failed to fetch HubSpot user info: No access token', { userEmail: email });
      return res.status(401).json({ success: false, message: 'No HubSpot access token provided.' });
    }

    logger.info('Fetching HubSpot user info', { userEmail: email });

    // Get account info from HubSpot
    const url = 'https://api.hubapi.com/crm/v3/objects/contacts?limit=1';
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`HubSpot API error: ${response.status}`);
    }

    logger.info('Successfully fetched HubSpot user info', { userEmail: email });

    res.json({
      success: true,
      data: {
        username: 'hubspot-user',
        email: email,
        portal: 'HubSpot'
      }
    });
  } catch (error) {
    logger.error('Error fetching HubSpot user info', {
      error: error.message,
      stack: error.stack,
      userEmail: email
    });
    res.status(500).json({ success: false, error: error.message });
  }
};

// Helper function to map HubSpot field types to standard types
function mapHubSpotFieldType(hubspotType) {
  const typeMap = {
    'string': 'string',
    'number': 'number',
    'date': 'date',
    'datetime': 'datetime',
    'enumeration': 'picklist',
    'bool': 'boolean',
    'phone_number': 'phone',
    'email': 'email',
    'currency': 'currency',
    'richtext': 'textarea',
    'calculation_updated_at': 'datetime',
    'duration': 'number',
    'json': 'json'
  };

  return typeMap[hubspotType] || 'string';
}
