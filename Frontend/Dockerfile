# Stage 1: Build the Angular application
FROM node:20-alpine AS build

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --legacy-peer-deps

# Copy all frontend source code
COPY . .

# Build the Angular app for production
RUN npm run build -- --configuration=production

# Stage 2: Serve the app using NGINX
FROM nginx:alpine

# Copy the compiled output from Stage 1 to NGINX's default public folder
COPY --from=build /app/dist /usr/share/nginx/html

# Expose port 80 for the NGINX server
EXPOSE 80

# Start NGINX
CMD ["nginx", "-g", "daemon off;"]