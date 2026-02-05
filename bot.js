const TelegramBot = require('node-telegram-bot-api');
const Nodeactyl = require('nodeactyl');
const http = require('http');

// Configuración de variables desde Render
const token = process.env.token;
const host = process.env.host;
const key = process.env.key;

const bot = new TelegramBot(token, { polling: true });
const client = new Nodeactyl.NodeactylClient(host, key);

// Menú principal con botones
const mainMenu = {
    reply_markup: {
        inline_keyboard: [
            [{ text: '📊 Ver y Controlar Servidores', callback_data: 'status' }],
            [{ text: '👤 Mi Perfil', callback_data: 'login' }]
        ]
    }
};

// Comando /start
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "👋 **Panel Xeon v2**\n¿Qué servidor quieres gestionar?", { 
        parse_mode: 'Markdown', 
        reply_markup: mainMenu.reply_markup 
    });
});

// Manejador de botones (Callback Query)
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;

    // Acción: Listar servidores
    if (data === 'status') {
        bot.answerCallbackQuery(query.id);
        await mostrarControlIndividual(chatId);
    }

    // Acción: Ver perfil
    if (data === 'login') {
        bot.answerCallbackQuery(query.id);
        client.getAccountDetails().then(value => {
            bot.sendMessage(chatId, `👤 **Perfil de Usuario**\n\nUsuario: ${value.username}\nEmail: ${value.email}`, mainMenu);
        }).catch(err => {
            bot.sendMessage(chatId, "❌ Error al obtener perfil: " + err.message);
        });
    }

    // Acción: Control de Energía (Start, Stop, Restart)
    if (data.startsWith('pwr_')) {
        const [_, action, srvId] = data.split('_');
        bot.answerCallbackQuery(query.id, { text: `Ejecutando ${action}...` });
        
        try {
            // Intentamos enviar la señal al panel
            await client.postServerAction(srvId, action);
            bot.sendMessage(chatId, `✅ Servidor \`${srvId}\`:\nSeñal **${action.toUpperCase()}** enviada correctamente.`, { parse_mode: 'Markdown' });
        } catch (err) {
            // Si falla, nos dirá el motivo real (403 permiso, 404 no encontrado, etc.)
            console.error("Error de Nodeactyl:", err);
            bot.sendMessage(chatId, `❌ **Error de Control**\nEl panel dice: ${err.message || "Acceso denegado"}\n\n_Revisa que la API Key en Render sea la nueva._`, { parse_mode: 'Markdown' });
        }
    }
});

// Función para mostrar cada servidor como una "tarjeta" con botones
async function mostrarControlIndividual(chatId) {
    try {
        const response = await client.getAllServers();
        const servers = Array.isArray(response) ? response : (response.data || []);
        
        if (servers.length === 0) {
            return bot.sendMessage(chatId, "No se encontraron servidores en esta cuenta.");
        }

        for (const server of servers) {
            const name = server.attributes ? server.attributes.name : server.name;
            const id = server.attributes ? server.attributes.identifier : server.identifier;
            
            try {
                const stats = await client.getServerUsages(id);
                const ramMB = (stats.resources.memory_bytes / 1024 / 1024).toFixed(2);
                const cpu = stats.resources.cpu_absolute.toFixed(2);
                let estado = stats.current_state === 'running' ? '✅ Encendido' : '🛑 Apagado';

                const mensaje = `🖥 **Servidor:** ${name}\n` +
                                `🆔 ID: \`${id}\`\n` +
                                `📊 Estado: ${estado}\n` +
                                `📉 CPU: ${cpu}%\n` +
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
                // Si el servidor está suspendido o no da stats, mostramos lo básico
                bot.sendMessage(chatId, `🖥 **Servidor:** ${name}\n🆔 ID: \`${id}\`\n⚠️ No se pudieron obtener estadísticas en tiempo real.`, {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '▶️ Start', callback_data: `pwr_start_${id}` },
                            { text: '⏹ Stop', callback_data: `pwr_stop_${id}` }
                        ]]
                    }
                });
            }
        }
    } catch (error) {
        bot.sendMessage(chatId, "❌ Error al conectar con el panel: " + error.message);
    }
}

// Mini servidor para mantener Render feliz (Puerto 8080)
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot de Pterodactyl en funcionamiento\n');
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`✅ Servidor de apoyo escuchando en el puerto ${PORT}`);
});
