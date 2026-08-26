FROM node:20-alpine
# Ghostscript downsamples the scanned-photo-in-a-PDF-wrapper documents customers/advisors
# send (receipts, guías) — sharp/libvips handles images but not PDF recompression.
RUN apk add --no-cache ghostscript
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY src ./src
EXPOSE 4000
CMD ["node", "src/index.js"]
