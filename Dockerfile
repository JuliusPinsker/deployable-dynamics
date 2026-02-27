# Development Dockerfile — mounts project directory to /app so edits reflect immediately
FROM node:20-bullseye-slim

WORKDIR /app
ENV NODE_ENV=development

# Install dependencies required by Playwright (browsers deps)
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  libnss3 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libxcomposite1 \
  libxrandr2 \
  libgbm-dev \
  libasound2 \
  libxss1 \
  libxdamage1 \
  libxfixes3 \
  libgtk-3-0 \
  wget \
  && rm -rf /var/lib/apt/lists/*

# Copy only package manifests first (for cached installs)
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# Install Playwright browsers (and necessary platform dependencies)
RUN npx playwright install --with-deps || true

# Expose Vite dev server
EXPOSE 5173

# Mount project directory at runtime to enable live edits
CMD ["npm", "run", "dev"]
