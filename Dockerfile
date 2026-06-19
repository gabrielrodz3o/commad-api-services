FROM node:22-alpine
WORKDIR /app

RUN corepack enable

# Dependencias (cacheable)
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile

# Código
COPY . .

ENV NODE_ENV=production
ENV PORT=4080
EXPOSE 4080

CMD ["pnpm", "start"]
