// server.js
// Serves the built Angular app (dist folder) as static files on Railway.
// Place this file in the ROOT of your Angular project (same level as package.json, angular.json).

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// Matches this project's angular.json: "outputPath": "dist"
const DIST_FOLDER = path.join(__dirname, 'dist');

app.use(express.static(DIST_FOLDER));

// Angular is a single-page app — all routes fall back to index.html
// so client-side routing works on refresh/direct URL access.
// Express 5.x (path-to-regexp v7) no longer accepts bare '*' — use
// a named wildcard parameter instead: '/*splat'
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(DIST_FOLDER, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Frontend server running on port ${PORT}`);
});
