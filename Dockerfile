FROM node:22-bookworm

WORKDIR /app

# System tools the app shells out to at runtime:
#   zip          - building the ZIP archive / XLSX result downloads
#   poppler-utils - pdftotext, for extracting text from PDF attachments
#   antiword     - best-effort text extraction from legacy .doc files
#   binutils     - `strings`, fallback extractor for .doc and other binary files
#   python3/pip  - running scripts/extract-xls.py (legacy .xls support)
RUN apt-get update && apt-get install -y --no-install-recommends \
    zip \
    poppler-utils \
    antiword \
    binutils \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# xlrd is the only Python dependency extract-xls.py needs (see pyproject.toml).
RUN pip install --no-cache-dir --break-system-packages xlrd

COPY . .

RUN corepack enable
RUN pnpm install --frozen-lockfile
RUN pnpm run build:railway

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "artifacts/api-server/dist/index.mjs"]
