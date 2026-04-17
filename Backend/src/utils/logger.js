const winston = require('winston');
const path = require('path');
const DailyRotateFile = require('winston-daily-rotate-file'); // <-- Added this
const { combine, timestamp, printf, colorize, json, label } = winston.format;

// Export a function that accepts the filename where the logger is being used
const buildLogger = (filePath) => {
  // Extract just the file name (e.g., 'auth.controller.js' instead of '/usr/src/app/...')
  const fileName = filePath ? path.basename(filePath) : 'app';

  // 1. Format for local development (Console)
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

  // 2. Format for Production/Serverless (and our JSON log files)
  const prodFormat = combine(
    label({ label: fileName }), // Injects "label": "filename.js" into the JSON
    timestamp(),
    json()
  );

  // 3. Configure the Daily Rotate File Transport <-- Added this section
  const fileTransport = new DailyRotateFile({
    dirname: path.join(__dirname, '../logs'), // Saves in a 'logs' folder one level up
    filename: 'Data Migration-logs-%DATE%.json',         // Appends the date to the file name
    datePattern: 'YYYY-MM-DD',                // Rotates every night at midnight
    zippedArchive: true,                      // Compresses old logs
    maxSize: '20m',                           // Rotates early if file hits 20MB
    maxFiles: '2d',                          // Deletes logs older than 2 days
    format: prodFormat                        // Forces the file to ALWAYS save as JSON
  });

  // 4. Create and return the Winston instance
  return winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    transports: [
      // The Console output respects your NODE_ENV (Readable in Dev, JSON in Prod)
      new winston.transports.Console({
        format: process.env.NODE_ENV === 'production' ? prodFormat : devFormat
      }),
      
      // The File output will continuously save day-wise JSON logs regardless of environment
      fileTransport
    ],
  });
};

module.exports = buildLogger;