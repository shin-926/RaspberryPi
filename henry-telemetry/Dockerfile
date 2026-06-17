FROM python:3.13-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .
COPY templates ./templates

EXPOSE 3004
CMD ["gunicorn", "--bind", "0.0.0.0:3004", "--workers", "2", "--timeout", "30", "server:app"]
