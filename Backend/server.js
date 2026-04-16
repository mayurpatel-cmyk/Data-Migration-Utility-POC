require('dotenv').config();
const app = require('./app');
const logger = require('./src/utils/logger')(__filename);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  logger.info(`Server is running securely on port ${PORT}`);
});