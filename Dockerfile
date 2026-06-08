FROM node:26-trixie AS build
COPY package.json package-lock.json /app/
RUN cd /app && npm ci 
COPY watcher.js /app/

FROM node:26-trixie-slim
COPY --from=build /app /app
ENV MQTT_BROKER ''
WORKDIR /app
ENTRYPOINT [ "node", "/app/watcher.js" ]