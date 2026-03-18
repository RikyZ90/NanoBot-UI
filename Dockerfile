FROM python:3.12-slim

WORKDIR /app

# Install dependencies and Docker CLI
RUN apt-get update && apt-get install -y \
    curl \
    && curl -fsSL https://get.docker.com -o get-docker.sh \
    && sh get-docker.sh \
    && rm get-docker.sh \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Expose the port the app runs on
EXPOSE 50002

# Disable python buffering for real-time logs
ENV PYTHONUNBUFFERED=1

# Command to run the application with correct port
CMD ["python", "server.py", "--port", "50002"]
