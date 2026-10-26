FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
RUN mkdir -p /app/uploads /app/logs && chown -R node:node /app/uploads /app/logs
USER node
EXPOSE 4000
CMD ["node", "src/index.js"]
