# Stage 1: Build Angular
FROM node:20-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY . .
RUN npm run build -- --configuration=production

# Stage 2: Serve with NGINX
FROM nginx:alpine

# Replace <your-angular-project-name> with your actual project folder name in dist/
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
