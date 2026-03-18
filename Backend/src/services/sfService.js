class SalesforceService {
  /**
   * Fetches only Standard Objects (Account, Contact, etc.)
   */
  async getStandardObjects(conn) {
    const meta = await conn.describeGlobal();
    // Filter: custom === false and it must be layoutable/queryable
    return meta.sobjects
      .filter(obj => !obj.custom && obj.queryable)
      .map(obj => ({
        name: obj.name,
        label: obj.label,
        keyPrefix: obj.keyPrefix
      }));
  }

  /**
   * Fetches all fields for a specific object
   */
  async getFieldsForObject(conn, objectName) {
    const meta = await conn.sobject(objectName).describe();
    return meta.fields.map(field => ({
      name: field.name,
      label: field.label,
      type: field.type,
      length: field.length,
      custom: field.custom // true if it's a custom field on a standard object
    }));
  }
}

module.exports = new SalesforceService();