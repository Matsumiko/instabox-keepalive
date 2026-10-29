# Keeps an instabox machine awake from a container host:
#   docker build -t instabox-keepalive .
#   docker run -d --restart=always --env-file .env instabox-keepalive
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

# watch keeps the container alive and ticks every INTERVAL seconds
ENV INTERVAL=300
CMD ["node", "src/cli.js", "watch"]
