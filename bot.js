const TelegramBot = require('node-telegram-bot-api');
const Nodeactyl = require('nodeactyl');

const token = process.env.token;
const host = process.env.host;
const key = process.env.key;

const bot = new TelegramBot(token, { polling: true });
const client = new Nodeactyl.NodeactylClient(host, key);

bot.setMyCommands([
    { command: '/start', description: 'Iniciar el bot' },
    { command: '/login', description: 'Ver mi perfil' },
    { command: '/status', description: 'Estado de mis servidores' }
]);

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "♥️ Bot conectado. Usa /status para ver tus servidores.");
});

bot.onText(/\/login/, (msg) => {
    client.getAccountDetails().then(value => {
        bot.sendMessage(msg.chat.id, `👤 Usuario: ${value.username}\n📧 Email: ${value.email}`);
    }).catch(err => bot.sendMessage(msg.chat.id, "❌ Error: " + err));
});

// NUEVO COMANDO: /status
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, "🔍 Consultando servidores...");

    try {
        // Obtenemos los servidores
        const response = await client.getAllServers();
        
        // El truco: Si no es una lista directa, buscamos dentro de 'data'
        const servers = Array.isArray(response) ? response : (response.data || []);
        
        if (servers.length === 0) {
            return bot.sendMessage(chatId, "No se encontraron servidores en tu cuenta.");
        }

        for (const server of servers) {
            // Sacamos los datos básicos del servidor
            const name = server.attributes ? server.attributes.name : server.name;
            const id = server.attributes ? server.attributes.identifier : server.identifier;

            try {
                const stats = await client.getServerUsages(id);
                const ramMB = (stats.resources.memory_bytes / 1024 / 1024).toFixed(2);
                const cpu = stats.resources.cpu_absolute.toFixed(2);
                let estado = stats.current_state === 'running' ? '✅ Encendido' : '🛑 Apagado';

                const mensaje = `🖥 **Servidor:** ${name}\n` +
                                `🆔 **ID:** \`${id}\`\n` +
                                `📊 **Estado:** ${estado}\n` +
                                `📉 **CPU:** ${cpu}%\n` +
                                `📟 **RAM:** ${ramMB} MB`;

                bot.sendMessage(chatId, mensaje, { parse_mode: 'Markdown' });
            } catch (err) {
                bot.sendMessage(chatId, `🖥 **Servidor:** ${name}\n⚠️ No pude obtener estadísticas detalladas.`);
            }
        }
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, "❌ Error al conectar con el panel: " + error.message);
    }
});

// Mini servidor para que Render no dé error de puerto
const http = require('http');
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running\n');
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`✅ Servidor web de apoyo escuchando en el puerto ${PORT}`);
});

