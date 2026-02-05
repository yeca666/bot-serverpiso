FROM node:18
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# El puerto que usa tu bot
EXPOSE 8080
CMD ["node", "bot.js"]
