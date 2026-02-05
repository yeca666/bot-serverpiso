const TelegramBot = require('node-telegram-bot-api');
const Nodeactyl = require('nodeactyl');
const http = require('http');

const token = process.env.token;
const host = process.env.host;
const key = process.env.key;

const bot = new TelegramBot(token, { polling: true });
const client = new Nodeactyl.NodeactylClient(host, key);

const mainMenu = {
    reply_markup: {
        inline_keyboard: [
            [{ text: '📊 Ver y Controlar Servidores', callback_data: 'status' }],
            [{ text: '👤 Mi Perfil', callback_data: 'login' }]
        ]
    }
};

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "👋 **Panel Xeon v2**\n¿Qué servidor quieres gestionar?", { parse_mode: 'Markdown', ...mainMenu });
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;

    if (data === 'status') {
        bot.answerCallbackQuery(query.id);
        await mostrarControlIndividual(chatId);
    }

    if (data === 'login') {
        client.getAccountDetails().then(value => {
            bot.sendMessage(chatId, `👤 **Perfil**\nUsuario: ${value.username}\nEmail: ${value.email}`, mainMenu);
        });
    }

    // --- CORRECCIÓN DE ENERGÍA ---
    if (data.startsWith('pwr_')) {
        const [_, action, srvId] = data.split('_');
        bot.answerCallbackQuery(query.id, { text: `Enviando ${action}...` });
        
        try {
            // La función correcta en Nodeactyl es postServerAction
            await client.postServerAction(srvId, action);
            bot.sendMessage(chatId, `✅ Servidor \`${srvId}\`: Señal **${action.toUpperCase()}** enviada.`, { parse_mode: 'Markdown' });
        } catch (err) {
            bot.sendMessage(chatId, "❌ Error: Asegúrate de que la API Key tenga permisos de control.");
        }
    }
});

async function mostrarControlIndividual(chatId) {
    try {
        const response = await client.getAllServers();
        const servers = Array.isArray(response) ? response : (response.data || []);
        
        for (const server of servers) {
            const name = server.attributes ? server.attributes.name : server.name;
            const id = server.attributes ? server.attributes.identifier : server.identifier;
            
            // Consultamos stats para cada uno
            try {
                const stats = await client.getServerUsages(id);
                const ramMB = (stats.resources.memory_bytes / 1024 / 1024).toFixed(2);
                let estado = stats.current_state === 'running' ? '✅ Encendido' : '🛑 Apagado';

                const mensaje = `🖥 **Servidor:** ${name}\n` +
                                `🆔 ID: \`${id}\`\n` +
                                `📊 Estado: ${estado}\n` +
                                `📟 RAM: ${ramMB} MB`;

                const botones = {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '▶️ Start', callback_data: `pwr_start_${id}` },
                                { text: '⏹ Stop', callback_data: `pwr_stop_${id}` },
                                { text: '🔄 Reset', callback_data: `pwr_restart_${id}` }
                            ]
                        ]
                    }
                };

                bot.sendMessage(chatId, mensaje, { parse_mode: 'Markdown', ...botones });
            } catch (e) {
                bot.sendMessage(chatId, `🖥 **${name}**\n⚠️ No se pudo obtener el estado real.`);
            }
        }
    } catch (error) {
        bot.sendMessage(chatId, "❌ Error al listar: " + error.message);
    }
}

const server = http.createServer((req, res) => { res.writeHead(200); res.end('Running'); });
server.listen(process.env.PORT || 8080);
