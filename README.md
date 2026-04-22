# Full-Stack Data MIgration Application

##  Tech Stack
- **Frontend:** Angular
- **Backend (Main):** Node.js
- **Backend (Microservice):** Python

##  Project Structure
```text
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

### 1. Frontend
```bash
cd frontend 
npm install

### 2. BACKEND
```bash
cd Backend 
npm install

### 3. PYTHON
```bash
cd Python_service
pip install -r requirements.txt

##  Running the Application

BACKEND: npm run dev
FRONTEND: ng serve
PYTHON: uvicorn app.main:app --reload --port 8000