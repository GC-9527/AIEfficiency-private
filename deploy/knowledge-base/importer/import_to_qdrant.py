"""
CSV知识库向量化并导入Qdrant
- 读取 merged_songs_deduped_clean_utf8.csv
- 调用 Ollama nomic-embed-text 生成向量
- 批量导入 Qdrant (collection: music_knowledge)
"""

import pandas as pd
import requests
import time
from tqdm import tqdm
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct

# ============ 配置 ============
CSV_PATH = r"C:\ai\MusicAgent\exports\merged_songs_deduped_clean_utf8.csv"
QDRANT_URL = "http://localhost:6333"
OLLAMA_URL = "http://localhost:11434/api/embeddings"
COLLECTION_NAME = "music_knowledge"
EMBED_MODEL = "nomic-embed-text"
VECTOR_DIM = 768
BATCH_SIZE = 100
MAX_RETRIES = 3
RETRY_DELAY = 2

# ============ 初始化 ============
client = QdrantClient(url=QDRANT_URL)


def create_collection():
    """创建或重建 collection"""
    collections = [c.name for c in client.get_collections().collections]
    if COLLECTION_NAME in collections:
        print(f"[INFO] Collection '{COLLECTION_NAME}' 已存在，将删除重建")
        client.delete_collection(COLLECTION_NAME)

    client.create_collection(
        collection_name=COLLECTION_NAME,
        vectors_config=VectorParams(size=VECTOR_DIM, distance=Distance.COSINE),
    )
    print(f"[OK] Collection '{COLLECTION_NAME}' 创建成功 (dim={VECTOR_DIM}, cosine)")


def build_document(row):
    """拼接向量化文本：song_name by artist. Tags: tags"""
    parts = []
    song = str(row.get("song_name", "")).strip()
    artist = str(row.get("artist", "")).strip()
    album = str(row.get("album_name", "")).strip()
    tags = str(row.get("tags", "")).strip()

    if song and song != "nan":
        parts.append(song)
    if artist and artist != "nan":
        parts.append(f"by {artist}")
    if album and album != "nan":
        parts.append(f"from album {album}")
    if tags and tags != "nan":
        parts.append(f". Tags: {tags.replace('|', ', ')}")

    return " ".join(parts) if parts else ""


def get_embedding(text):
    """调用 Ollama API 获取 embedding，带重试"""
    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.post(
                OLLAMA_URL,
                json={"model": EMBED_MODEL, "prompt": text},
                timeout=30,
            )
            resp.raise_for_status()
            return resp.json()["embedding"]
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_DELAY)
            else:
                raise RuntimeError(f"Embedding 失败 (重试{MAX_RETRIES}次): {e}")


def main():
    # 1. 读取 CSV
    print(f"[1/4] 读取 CSV: {CSV_PATH}")
    df = pd.read_csv(CSV_PATH, encoding="utf-8-sig")
    total = len(df)
    print(f"  共 {total} 条记录，列: {list(df.columns)}")

    # 2. 创建 collection
    print(f"[2/4] 创建 Qdrant collection")
    create_collection()

    # 3. 向量化 + 导入
    print(f"[3/4] 向量化并导入 (batch_size={BATCH_SIZE})")
    success_count = 0
    error_count = 0
    errors = []

    batch_points = []
    pbar = tqdm(total=total, desc="导入进度", unit="条")

    for idx, row in df.iterrows():
        doc = build_document(row)
        if not doc:
            error_count += 1
            errors.append(f"Row {idx}: 空文档，跳过")
            pbar.update(1)
            continue

        try:
            vector = get_embedding(doc)
        except Exception as e:
            error_count += 1
            errors.append(f"Row {idx}: {e}")
            pbar.update(1)
            continue

        # 构建 payload（所有原始字段作为 metadata）
        payload = {}
        for col in df.columns:
            val = row[col]
            if pd.notna(val):
                payload[col] = str(val)
        payload["document"] = doc

        batch_points.append(PointStruct(id=idx, vector=vector, payload=payload))

        # 批量写入
        if len(batch_points) >= BATCH_SIZE:
            client.upsert(collection_name=COLLECTION_NAME, points=batch_points)
            success_count += len(batch_points)
            batch_points = []

        pbar.update(1)

    # 写入剩余
    if batch_points:
        client.upsert(collection_name=COLLECTION_NAME, points=batch_points)
        success_count += len(batch_points)

    pbar.close()

    # 4. 验证
    print(f"\n[4/4] 验证导入结果")
    info = client.get_collection(COLLECTION_NAME)
    print(f"  Collection: {COLLECTION_NAME}")
    print(f"  向量数量: {info.points_count}")
    print(f"  向量维度: {info.config.params.vectors.size}")
    print(f"  距离度量: {info.config.params.vectors.distance}")

    # 汇总
    print(f"\n{'='*50}")
    print(f"导入完成!")
    print(f"  CSV 总记录: {total}")
    print(f"  成功导入:   {success_count}")
    print(f"  失败/跳过:  {error_count}")
    if errors:
        print(f"\n失败详情 (前10条):")
        for e in errors[:10]:
            print(f"  - {e}")


if __name__ == "__main__":
    main()
