# Project Title
Full-Stack Data Migration Application

## Description


##  Tech Stack
- **Frontend:** Angular
- **Backend (Main):** Node.js
- **Backend (Microservice):** Python

##  Project Structure
├── frontend/          # Angular client application
├── backend/           # Node.js main backend server
└── python_service/    # Python data processing microservice

##  Prerequisites
Make sure you have the following installed on your local machine:
- [Node.js & npm](https://nodejs.org/)
- [Angular CLI](https://angular.io/cli) (`npm install -g @angular/cli`)
- [Python 3.8+](https://www.python.org/)

## Installation

Before running the application, install the dependencies for each part of the stack.

1. Frontend
cd frontend 
npm install

2. BACKEND
cd Backend 
npm install

3. PYTHON
cd Python_service
pip install -r requirements.txt


## Running the Application
1. BACKEND: npm run dev
2. FRONTEND: ng serve
3. PYTHON: uvicorn app.main:app --reload --port 8000
