# Shared image for every Fly app (fly/<svc>.toml picks the process command).
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["npm", "start"]
