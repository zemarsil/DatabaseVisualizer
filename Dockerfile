# Build the client, then serve it together with the API from one Node process.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server ./server
COPY src/shared ./src/shared
COPY tsconfig.server.json ./
EXPOSE 8787
# Inside a container we must listen on all interfaces; publish the port to 127.0.0.1 in compose.
ENV HOST=0.0.0.0
CMD ["npx", "tsx", "server/index.ts"]
