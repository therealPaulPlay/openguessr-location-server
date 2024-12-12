# Use the official Node.js image based on Debian with Node.js 18
FROM node:18-bullseye-slim

WORKDIR /usr/src/app

# Install Firefox dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    wget \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js dependencies
COPY package*.json ./
RUN npm install

# Install Playwright with Firefox
RUN npx playwright install firefox --with-deps

# Copy the rest of the application code
COPY . .

EXPOSE 3006

CMD ["node", "server.js"]