const connections = new Map();

module.exports = {
  setConnection: (email, conn) => connections.set(email, conn),
  getConnection: (email) => connections.get(email),
  hasConnection: (email) => connections.has(email)
};