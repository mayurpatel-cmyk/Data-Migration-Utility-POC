# Project Title
Full-Stack Data Migration Application
SureShift

## Description


##  Tech Stack
- **Frontend:** Angular
- **Backend (Main):** Python

##  Project Structure
├── frontend/          # Angular client application
└── python_service/    # Python data processing main backend server

##  Prerequisites
Make sure you have the following installed on your local machine:
- [Angular CLI](https://angular.io/cli) (`npm install -g @angular/cli`)
- [Python 3.8+](https://www.python.org/)

## Installation

Before running the application, install the dependencies for each part of the stack.

1. Frontend
cd frontend 
npm install

2. PYTHON
cd Python_service
pip install -r requirements.txt (Linux)
py -m pip install -r requirements.txt (Windows)

## Running the Application
1. FRONTEND: ng serve
2. PYTHON(Linux): uvicorn app.main:app --reload --port 8000
3. PYTHON(Windows): py -m uvicorn app.main:app --reload --port 8000

## Container Application
docker build -t test-backend .
docker run -p 3000:3000 test-backend

## ollama
ollama pull mxbai-embed-large

1. To build and start everything at once:-  docker-compose up --build
2. To run them in the background:- docker-compose up -d --build
3. To stop and remove all of them at once:- docker-compose down