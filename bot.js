const TelegramBot = require('node-telegram-bot-api');
const Nodeactyl = require('nodeactyl');
const http = require('http');
// Importación de fetch para hacer la petición tipo "curl"
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const token = process.env.token;
const host = process.env.host; // Debe ser http://92.185.36.177
const key = process.env.key;

const bot = new TelegramBot(token, { polling: true });
const client = new Nodeactyl.NodeactylClient(host, key);

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "👋 **Panel Xeon v2**\nGestión de servidores activada.", {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{ text: '📊 Ver y Controlar Servidores', callback_data: 'status' }]]
        }
    });
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data === 'status') {
        bot.answerCallbackQuery(query.id);
        await mostrarServidores(chatId);
    }

    if (data.startsWith('pwr_')) {
        const [_, action, srvId] = data.split('_');
        bot.answerCallbackQuery(query.id, { text: `Ejecutando ${action}...` });
        
        // Esta es la URL exacta que te funcionó en la consola
        const url = `${host}/api/client/servers/${srvId}/power`;
        
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({ signal: action })
            });

            // 204 es el código de éxito que devuelve Pterodactyl
            if (response.status === 204 || response.ok) {
                bot.sendMessage(chatId, `✅ Servidor \`${srvId}\`:\nSeñal **${action.toUpperCase()}** enviada.`);
            } else {
                const errorData = await response.json().catch(() => ({}));
                const detail = errorData.errors ? errorData.errors[0].detail : "Error desconocido";
                bot.sendMessage(chatId, `❌ Error del Panel: ${detail}`);
            }
        } catch (err) {
            bot.sendMessage(chatId, `❌ Error de conexión: ${err.message}`);
        }
    }
});

async function mostrarServidores(chatId) {
    try {
        const response = await client.getAllServers();
        const servers = Array.isArray(response) ? response : (response.data || []);
        
        for (const server of servers) {
            const name = server.attributes.name;
            const id = server.attributes.identifier; // Aquí pillará 3b2ee24a, etc.
            
            const mensaje = `🖥 **Servidor:** ${name}\n🆔 ID: \`${id}\``;
            const botones = {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '▶️ Start', callback_data: `pwr_start_${id}` },
                        { text: '⏹ Stop', callback_data: `pwr_stop_${id}` },
                        { text: '🔄 Reset', callback_data: `pwr_restart_${id}` }
                    ]]
                }
            };
            bot.sendMessage(chatId, mensaje, { parse_mode: 'Markdown', ...botones });
        }
    } catch (error) {
        bot.sendMessage(chatId, "❌ Error al listar: " + error.message);
    }
}

http.createServer((req, res) => { res.end('OK'); }).listen(process.env.PORT || 8080);
