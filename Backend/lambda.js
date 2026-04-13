// lambda.js
const serverless = require('serverless-http');
const app = require('./app'); // This grabs your express app just like server.js does

// We wrap the Express app in serverless-http so Lambda can understand the requests
module.exports.handler = serverless(app);