const TelegramBot = require('node-telegram-bot-api');
const Nodeactyl = require('nodeactyl');
const http = require('http');

const token = process.env.token;
const host = process.env.host;
const key = process.env.key;

const bot = new TelegramBot(token, { polling: true });
const client = new Nodeactyl.NodeactylClient(host, key);

// --- MENU PRINCIPAL ---
const mainMenu = {
    reply_markup: {
        inline_keyboard: [
            [
                { text: '📊 Estado Servidores', callback_data: 'status' },
                { text: '👤 Mi Perfil', callback_data: 'login' }
            ],
            [
                { text: '🔄 Actualizar', callback_data: 'status' }
            ]
        ]
    }
};

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "👋 ¡Hola! Bienvenido al panel de control Xeon.\n¿Qué deseas hacer hoy?", mainMenu);
});

// --- MANEJADOR DE CLICKS EN BOTONES ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const action = query.data;

    if (action === 'status') {
        bot.answerCallbackQuery(query.id, { text: "Consultando servidores..." });
        await mostrarStatus(chatId);
    } 
    
    if (action === 'login') {
        bot.answerCallbackQuery(query.id, { text: "Cargando perfil..." });
        client.getAccountDetails().then(value => {
            bot.sendMessage(chatId, `👤 Usuario: ${value.username}\n📧 Email: ${value.email}`, mainMenu);
        }).catch(err => bot.sendMessage(chatId, "❌ Error: " + err));
    }
});

// --- FUNCIÓN DE STATUS (Separada para poder llamarla desde el botón) ---
async function mostrarStatus(chatId) {
    try {
        const response = await client.getAllServers();
        const servers = Array.isArray(response) ? response : (response.data || []);
        
        if (servers.length === 0) {
            return bot.sendMessage(chatId, "No se encontraron servidores.", mainMenu);
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
                                `📊 **Estado:** ${estado}\n` +
                                `📉 **CPU:** ${cpu}%\n` +
                                `📟 **RAM:** ${ramMB} MB`;

                bot.sendMessage(chatId, mensaje, { parse_mode: 'Markdown' });
            } catch (err) {
                bot.sendMessage(chatId, `🖥 **Servidor:** ${name}\n⚠️ Sin datos.`);
            }
        }
        // Volvemos a enviar el menú al final
        bot.sendMessage(chatId, "¿Deseas algo más?", mainMenu);
    } catch (error) {
        bot.sendMessage(chatId, "❌ Error: " + error.message, mainMenu);
    }
}

// Servidor de apoyo para Render
const server = http.createServer((req, res) => { res.writeHead(200); res.end('Running'); });
server.listen(process.env.PORT || 8080);
