FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY import_to_qdrant.py .
COPY import_remote.py .

CMD ["python", "import_remote.py"]
