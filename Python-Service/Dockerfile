# Use an official lightweight Python image
FROM python:3.11-slim

# Prevent Python from writing .pyc files to disk and enable unbuffered logging
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Set the working directory inside the container
WORKDIR /app

# Copy the requirements file and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the 'app' folder into the container
COPY app/ ./app/

# Expose the port your Python service runs on (assuming 5000, change if different)
EXPOSE 8000

# Command to run your Python application
# Replace 'main.py' with the actual starting script inside your 'app' folder
CMD ["python", "app/main.py"]