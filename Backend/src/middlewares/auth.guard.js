const jwt = require('jsonwebtoken');

const verifyToken = (req, res, next) => {
  // Check for the token in the Authorization header (e.g., "Bearer eyJhbGci...")
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(403).json({ success: false, message: 'No token provided. Access denied.' });
  }

  // Extract the token
  const token = authHeader.split(' ')[1];

  try {
    // Verify the token using your secret
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Attach the decoded user payload to the request object
    // so future controllers know exactly who is making the request
    req.user = decoded;
    
    // Move to the next function (the controller)
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
  }
};

module.exports = { verifyToken };