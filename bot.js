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
            [{ text: '📊 Estado y Control', callback_data: 'status' }],
            [{ text: '👤 Mi Perfil', callback_data: 'login' }],
            [{ text: '🔄 Actualizar Menú', callback_data: 'main_menu' }]
        ]
    }
};

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "👋 Panel Xeon Activo.\nSelecciona una opción:", mainMenu);
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;

    // --- ACCIÓN: VOLVER AL MENÚ ---
    if (data === 'main_menu') {
        bot.editMessageText("👋 Menú Principal de Xeon.\n¿Qué deseas hacer?", {
            chat_id: chatId, message_id: messageId, reply_markup: mainMenu.reply_markup
        });
    }

    // --- ACCIÓN: MOSTRAR SERVIDORES ---
    if (data === 'status') {
        bot.answerCallbackQuery(query.id, { text: "Cargando servidores..." });
        await mostrarServidoresControl(chatId, messageId);
    }

    // --- ACCIÓN: PERFIL ---
    if (data === 'login') {
        client.getAccountDetails().then(value => {
            bot.editMessageText(`👤 **Perfil**\nUsuario: ${value.username}\nEmail: ${value.email}`, {
                chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: mainMenu.reply_markup
            });
        });
    }

    // --- ACCIÓN: ENVIAR COMANDO DE ENERGÍA ---
    // El formato será: "power_start_id", "power_stop_id", etc.
    if (data.startsWith('pwr_')) {
        const [_, action, srvId] = data.split('_');
        bot.answerCallbackQuery(query.id, { text: `Enviando señal: ${action}...` });
        
        try {
            await client.sendServerSignal(srvId, action);
            bot.sendMessage(chatId, `✅ Señal **${action.toUpperCase()}** enviada con éxito al servidor \`${srvId}\`.`, { parse_mode: 'Markdown' });
            // Refrescamos el estado después de 2 segundos para ver el cambio
            setTimeout(() => mostrarServidoresControl(chatId, messageId), 2000);
        } catch (err) {
            bot.sendMessage(chatId, "❌ Error al enviar señal: " + err);
        }
    }
});

async function mostrarServidoresControl(chatId, messageId) {
    try {
        const response = await client.getAllServers();
        const servers = Array.isArray(response) ? response : (response.data || []);
        
        let texto = "🎮 **Control de Servidores**\nHaz clic en los botones para gestionar la energía:\n\n";
        let botones = [];

        for (const server of servers) {
            const name = server.attributes ? server.attributes.name : server.name;
            const id = server.attributes ? server.attributes.identifier : server.identifier;
            
            // Añadimos info al texto
            texto += `🖥 **${name}** (\`${id}\`)\n\n`;
            
            // Creamos una fila de botones por cada servidor
            botones.push([
                { text: `▶️ Start`, callback_data: `pwr_start_${id}` },
                { text: `⏹ Stop`, callback_data: `pwr_stop_${id}` },
                { text: `🔄 Reset`, callback_data: `pwr_restart_${id}` }
            ]);
        }

        botones.push([{ text: '⬅️ Volver', callback_data: 'main_menu' }]);

        bot.editMessageText(texto, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: botones }
        });

    } catch (error) {
        bot.sendMessage(chatId, "❌ Error: " + error.message);
    }
}

const server = http.createServer((req, res) => { res.writeHead(200); res.end('Running'); });
server.listen(process.env.PORT || 8080);
