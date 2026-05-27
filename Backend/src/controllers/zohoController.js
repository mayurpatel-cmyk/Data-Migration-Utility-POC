const fetch = require('node-fetch');

exports.getAllModules = async (req, res) => {
  const token = req.headers['zoho-access-token'];
  
  const apiDomain = req.headers['zoho-api-domain']; // Dynamically populated from frontend login context

  try {
    const url = `${apiDomain}/crm/v6/settings/modules`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Zoho-oauthtoken ${token}` }
    });

    const data = await response.json();
    const modules = (data.modules || [])
      .filter(m => m.visible && m.api_name)
      .map(m => ({ name: m.api_name, label: m.plural_label }));

    res.json({ success: true, data: modules });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getModuleFields = async (req, res) => {
  const { moduleName } = req.params;
  const token = req.headers['zoho-access-token'];
  const apiDomain = req.headers['zoho-api-domain'];

  try {
    const url = `${apiDomain}/crm/v6/settings/fields?module=${moduleName}`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Zoho-oauthtoken ${token}` }
    });

    const data = await response.json();
    const fields = (data.fields || []).map(f => ({
      name: f.api_name,
      label: f.field_label,
      type: f.data_type,
      isRequired: f.required || false,
      referenceTo: f.lookup ? [f.lookup.module] : null
    }));

    res.json({ success: true, object: moduleName, fields });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};