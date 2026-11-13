FROM node:22-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY server.mjs ./
COPY web ./web
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
