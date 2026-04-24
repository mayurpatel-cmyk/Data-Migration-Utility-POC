# Use a lightweight Node.js image
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json first to leverage Docker caching
COPY package*.json ./

# Install production dependencies
RUN npm install --only=production

# Copy the rest of your backend code
COPY . .

# Expose the port your backend runs on (assuming 3000, change if different)
EXPOSE 3000

# Start the server (change 'server.js' to 'app.js' if app.js is your actual entry point)
CMD ["node", "server.js"]