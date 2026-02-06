const TelegramBot = require('node-telegram-bot-api');
const Nodeactyl = require('nodeactyl');
const http = require('http');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const token = process.env.token;
const host = process.env.host; 
const key = process.env.key;

const bot = new TelegramBot(token, { polling: true });
const client = new Nodeactyl.NodeactylClient(host, key);

const mainMenu = {
    reply_markup: {
        inline_keyboard: [
            [{ text: '📊 Ver y Controlar Servidores', callback_data: 'status' }]
        ]
    }
};

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "👋 **Panel Xeon v2**\nGestión de servidores lista.", {
        parse_mode: 'Markdown',
        reply_markup: mainMenu.reply_markup
    });
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data === 'status') {
        bot.answerCallbackQuery(query.id, { text: "Consultando servidores..." });
        await mostrarServidores(chatId);
    }

    if (data.startsWith('pwr_')) {
        const [_, action, srvId] = data.split('_');
        bot.answerCallbackQuery(query.id, { text: `Enviando ${action}...` });
        
        const url = `${host}/api/client/servers/${srvId}/power`;
        
        try {
            // Intentamos obtener el nombre del servidor antes de enviar la señal
            // para que la respuesta sea más bonita
            const srvInfo = await client.getServerDetails(srvId);
            const serverName = srvInfo.name || srvId;

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({ signal: action })
            });

            if (response.status === 204 || response.ok) {
                // CAMBIO AQUÍ: Ahora usa serverName en lugar de srvId
                bot.sendMessage(chatId, `✅ Servidor: **${serverName}**\nSeñal **${action.toUpperCase()}** enviada con éxito.`, { parse_mode: 'Markdown' });
            } else {
                const errorData = await response.json().catch(() => ({}));
                const detail = errorData.errors ? errorData.errors[0].detail : "Error en la petición";
                bot.sendMessage(chatId, `❌ Error del Panel: ${detail}`);
            }
        } catch (err) {
            bot.sendMessage(chatId, `❌ Error: ${err.message}`);
        }
    }
});

async function mostrarServidores(chatId) {
    try {
        const response = await client.getAllServers();
        const servers = Array.isArray(response) ? response : (response.data || []);
        
        for (const server of servers) {
            const name = server.attributes.name;
            const id = server.attributes.identifier;
            
            let estadoIcono = '⚪️';
            
            try {
                const stats = await client.getServerUsages(id);
                estadoIcono = stats.current_state === 'running' ? '🟢' : '🔴';
            } catch (e) {
                estadoIcono = '⚠️'; 
            }
            
            const mensaje = `${estadoIcono} **Servidor:** ${name}\n🆔 ID: \`${id}\``;
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

http.createServer((req, res) => { res.writeHead(200); res.end('OK'); }).listen(process.env.PORT || 8080);
