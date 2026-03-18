const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

// 1. Import your isolated route files
const authRoutes = require('./src/routes/auth.routes');
const sfRoutes = require('./src/routes/sfRoutes');

const app = express();

// --- GLOBAL SECURITY MIDDLEWARE ---
app.use(helmet());

const corsOptions = {
  origin: process.env.FRONTEND_URL || 'http://localhost:4200',
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(express.json());


// --- ROUTES ---

// 2. Attach your auth routes to the /api/auth path
// This means the router.post('/login') in auth.routes.js automatically becomes /api/auth/login
app.use('/api/auth', authRoutes);
app.use('/api/sf', sfRoutes);


// Export the app
module.exports = app;