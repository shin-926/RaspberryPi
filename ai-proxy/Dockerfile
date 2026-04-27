FROM python:3.13-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .

EXPOSE 3002
CMD ["gunicorn", "--bind", "0.0.0.0:3002", "--workers", "2", "--timeout", "120", "server:app"]
