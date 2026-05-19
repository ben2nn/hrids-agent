# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY web/package*.json ./web/

# Install dependencies
RUN npm ci --ignore-scripts=false
RUN cd web && npm ci

# Copy source code
COPY . .

# Build project
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts=false && npm cache clean --force

# Copy built files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/config.example.yaml ./config.example.yaml

# Create data directory for SQLite
RUN mkdir -p /app/data

# Create non-root user
RUN addgroup -g 1001 -S hrids && \
    adduser -S hrids -u 1001 -G hrids

# Set ownership
RUN chown -R hrids:hrids /app

USER hrids

# Expose port for gateway mode
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "process.exit(0)" || exit 1

# Default command
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["--help"]
