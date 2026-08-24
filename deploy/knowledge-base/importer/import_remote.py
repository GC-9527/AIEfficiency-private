"""Remote import entrypoint driven by environment variables."""

import os

import import_to_qdrant as m
from qdrant_client import QdrantClient

os.environ.setdefault("QDRANT_URL_OVERRIDE", "http://qdrant:6333")
os.environ.setdefault("OLLAMA_URL_OVERRIDE", "http://ollama:11434/api/embeddings")
os.environ.setdefault("CSV_PATH_OVERRIDE", "/work/data/merged_songs_deduped_clean_utf8.csv")
os.environ.setdefault("COLLECTION_NAME_OVERRIDE", "music_knowledge")
os.environ.setdefault("EMBED_MODEL_OVERRIDE", "nomic-embed-text")
os.environ.setdefault("VECTOR_DIM_OVERRIDE", "768")

m.QDRANT_URL = os.environ["QDRANT_URL_OVERRIDE"]
m.OLLAMA_URL = os.environ["OLLAMA_URL_OVERRIDE"]
m.CSV_PATH = os.environ["CSV_PATH_OVERRIDE"]
m.COLLECTION_NAME = os.environ["COLLECTION_NAME_OVERRIDE"]
m.EMBED_MODEL = os.environ["EMBED_MODEL_OVERRIDE"]
m.VECTOR_DIM = int(os.environ["VECTOR_DIM_OVERRIDE"])
m.client = QdrantClient(url=m.QDRANT_URL)

m.main()
