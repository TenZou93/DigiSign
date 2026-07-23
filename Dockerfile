FROM node:20-alpine

WORKDIR /app

COPY backend/package.json ./backend/
RUN cd backend && npm install

COPY . .

RUN mkdir -p uploads/guest_temp uploads/signed uploads/qr uploads/originals keys frontend/public/uploads

EXPOSE 3009

CMD ["node", "backend/server.js"]
