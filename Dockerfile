FROM node:22-bookworm
WORKDIR /app
COPY . .
RUN apt-get update && apt-get install -y unzip \
    && ZIPFILE=$(ls -S *.zip | head -n1) \
    && unzip -o "$ZIPFILE" -d /tmp/extracted \
    && EXTRACTED_DIR=$(ls /tmp/extracted) \
    && rm -rf /app/* \
    && mv /tmp/extracted/"$EXTRACTED_DIR"/* /app/ \
    && rm -rf /tmp/extracted
RUN corepack enable
RUN pnpm install --frozen-lockfile
RUN pnpm run build:railway
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "artifacts/api-server/dist/index.mjs"]
