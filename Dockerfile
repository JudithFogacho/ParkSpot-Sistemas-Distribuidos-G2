FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY config ./config
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
EXPOSE 3000 4001 4002 4003
CMD ["node", "src/gateway/server.js"]
