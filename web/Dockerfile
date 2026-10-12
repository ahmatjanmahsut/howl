FROM node:20-slim
RUN apt-get update -qq && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY catalog.js server.js ./
COPY public ./public
EXPOSE 8090
CMD ["node", "server.js"]
