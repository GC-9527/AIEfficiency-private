# Knowledge Base Deployment

This package deploys the standalone music knowledge base stack without n8n:

- `rag-search`: hybrid keyword + vector search API
- `qdrant`: vector database
- `ollama`: embedding model runtime
- `caddy`: HTTPS reverse proxy for `tgcz.appgrabz.com`

## Directory Layout

- `docker-compose.yml`: main deployment entrypoint
- `.env`: default deployment variables
- `caddy/Caddyfile`: reverse proxy and HTTPS config
- `caddy/certs/`: place `fullchain.pem` and `privkey.pem` here
- `importer/data/`: place the CSV knowledge base file here

## Quick Start

1. Copy the CSV file to `importer/data/merged_songs_deduped_clean_utf8.csv`.
2. Copy TLS certificate files to `caddy/certs/fullchain.pem` and `caddy/certs/privkey.pem`.
3. Review `.env` and adjust ports/model if needed.
4. Start core services:

   ```bash
   docker compose up -d qdrant ollama rag-search caddy
   ```

5. Pull the embedding model:

   ```bash
   docker compose --profile init run --rm ollama-init
   ```

6. Import the CSV into Qdrant:

   ```bash
   docker compose --profile init run --rm kb-importer
   ```

7. Verify service health:

   ```bash
   curl -k https://tgcz.appgrabz.com/health
   ```

## Notes

- The stack keeps Qdrant, Ollama and rag-search debug ports bound to `127.0.0.1` only.
- Public traffic enters through Caddy on `80/443`.
- If you switch the embedding model, re-run the import step to rebuild the collection.
