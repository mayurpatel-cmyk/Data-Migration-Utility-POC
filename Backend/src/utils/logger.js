const winston = require('winston');
const path = require('path'); // Node's built-in path module
const { combine, timestamp, printf, colorize, json, label } = winston.format;

// Export a function that accepts the filename where the logger is being used
const buildLogger = (filePath) => {
  // Extract just the file name (e.g., 'auth.controller.js' instead of '/usr/src/app/...')
  const fileName = filePath ? path.basename(filePath) : 'app';

  // 1. Format for local development
  const devFormat = combine(
    colorize(),
    label({ label: fileName }), // Inject the file name as a label
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    // Include the label in the final string output
    printf(({ timestamp, level, message, label, ...meta }) => {
      const metaString = Object.keys(meta).length ? `\n${JSON.stringify(meta, null, 2)}` : '';
      return `[${timestamp}] [${label}] ${level}: ${message}${metaString}`;
    })
  );

  // 2. Format for Production/Serverless
  const prodFormat = combine(
    label({ label: fileName }), // Injects "label": "filename.js" into the JSON
    timestamp(),
    json()
  );

  // 3. Create and return the Winston instance
  return winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: process.env.NODE_ENV === 'production' ? prodFormat : devFormat,
    transports: [
      new winston.transports.Console()
    ],
  });
};

module.exports = buildLogger;