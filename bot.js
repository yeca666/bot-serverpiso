const TelegramBot = require('node-telegram-bot-api');
const Nodeactyl = require('nodeactyl');

/* USAMOS LAS VARIABLES DE RENDER */
const token = process.env.token;
const host = process.env.host; // Tu IP: http://92.185.36.177
const key = process.env.key;   // Tu API Key: ptlc_...

const bot = new TelegramBot(token, {
	polling: true
});

bot.setMyCommands([
	{
		command: '/start',
		description: 'Iniciar el bot'
	},
	{
		command: '/login',
		description: 'Ver mis datos del panel'
	}
]);

bot.onText(/\/start/, (msg) => {
	const chatId = msg.chat.id;
	bot.sendMessage(chatId, "♥️ ¡Hola! Estoy listo para gestionar tu panel Xeon.\n\nEscribe /login para probar la conexión.");
});

/* COMANDO LOGIN MODIFICADO */
bot.onText(/\/login/, (msg) => {
	const chatId = msg.chat.id;
	let first = msg.from.first_name;

	// Usamos la URL (host) y la Key que configuramos en Render
	let client = new Nodeactyl.NodeactylClient(host, key); 
	
	client.getAccountDetails().then(function (value) {
		bot.sendMessage(chatId, `✅ Conexión exitosa, ${first}!\n\n👤 Usuario: ${value.username}\n🆔 ID: ${value.id}\n📧 Email: ${value.email}`);
	}, function (reason) {
		bot.sendMessage(chatId, "❌ Error de conexión: " + reason);
	});
});
