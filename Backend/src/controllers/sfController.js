const sfService = require('../services/sfService');

exports.getStandardObjects = async (req, res) => {
  try {
    const email = req.headers['user-email']; // Just send the email you logged in with

    if (!conn) {
      return res.status(401).json({ success: false, message: "No active session for this email" });
    }

    const meta = await conn.describeGlobal();
    const standardObjects = meta.sobjects
      .filter(obj => !obj.custom && obj.queryable)
      .map(obj => ({ name: obj.name, label: obj.label }));

    res.json({ success: true, data: standardObjects });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getObjectFields = async (req, res) => {
  try {
    const { objectName } = req.params;
    const fields = await sfService.getFieldsForObject(req.sfConn, objectName);
    res.json({ success: true, object: objectName, fields });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};