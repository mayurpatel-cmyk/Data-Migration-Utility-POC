# Stage 1: Build the Angular application
FROM node:20-alpine AS build

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy all frontend source code
COPY . .

# Build the Angular app for production
RUN npm run build -- --configuration=production

# Stage 2: Serve the app using NGINX
FROM nginx:alpine

# Copy the compiled output from Stage 1 to NGINX's default public folder
# NOTE: Replace 'frontend' below with the actual name of your project defined in angular.json
COPY --from=build /app/dist/frontend/browser /usr/share/nginx/html

# Copy a custom NGINX configuration (Optional but recommended for routing)
# COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80 for the NGINX server
EXPOSE 80

# Start NGINX
CMD ["nginx", "-g", "daemon off;"]