FROM node:20-alpine

RUN echo "http://dl-cdn.alpinelinux.org/alpine/v3.20/community" >> /etc/apk/repositories \
    && apk add --no-cache \
      libreoffice-writer \
      libreoffice-common \
      font-noto \
      font-noto-extra \
      ttf-freefont \
      ttf-dejavu \
    && fc-cache -f \
    && rm -rf /var/cache/apk/* /tmp/*

WORKDIR /app

COPY backend/package.json ./backend/
RUN cd backend && npm install

COPY . .

RUN mkdir -p uploads/guest_temp uploads/signed uploads/qr uploads/originals keys frontend/public/uploads uploads/docx_templates uploads/docx_generated

EXPOSE 3009

CMD ["node", "backend/server.js"]
