const express = require('express');
const multer = require('multer');
const migrationController = require('../controllers/migration.controller');
const { verifyToken } = require('../middlewares/auth.guard'); // Your existing guard

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

router.get('/objects', verifyToken, migrationController.getObjects);
router.get('/fields/:name', verifyToken, migrationController.getFields);

// Protected route: requires JWT and a file
router.post('/upload', verifyToken, upload.single('file'), migrationController.migrate);

module.exports = router;