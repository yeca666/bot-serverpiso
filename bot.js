const TelegramBot = require('node-telegram-bot-api');
const { Client } = require('ssh2'); 
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// --- CONFIGURACIÓN ---
const token = process.env.token;
const host = process.env.host; 
const key = process.env.key;
const sshUser = process.env.ssh_user; 
const sshPass = process.env.ssh_pass;
const sshHost = '92.185.36.177';

const bot = new TelegramBot(token, { polling: true });

// --- FUNCIÓN SSH (Hardware Real) ---
function getHardwareStats() {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        conn.on('ready', () => {
            conn.exec("sensors && free -m", (err, stream) => {
                if (err) return reject(err);
                let output = '';
                stream.on('data', (d) => output += d).on('close', () => {
                    const tempMatch = output.match(/Package id 0:\s+\+([\d.]+)/);
                    const gpuMatch = output.match(/GPU core:\s+.*?temp1:\s+\+([\d.]+)/s);
                    const ramLine = output.match(/Mem:\s+(\d+)\s+(\d+)/);
                    resolve({
                        cpuTemp: tempMatch ? tempMatch[1] : "??",
                        gpuTemp: gpuMatch ? gpuMatch[1] : "??",
                        ramTotal: ramLine ? ramLine[1] : "16384",
                        ramUsed: ramLine ? ramLine[2] : "??"
                    });
                    conn.end();
                });
            });
        }).on('error', (err) => reject(err))
          .connect({ host: sshHost, port: 2222, username: sshUser, password: sshPass, readyTimeout: 20000 });
    });
}

// --- COMANDO /START ---
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    // 1. Aviso de carga (notificación pequeña)
    const loadingMsg = await bot.sendMessage(chatId, "⏳ Conectando al servidor, espera...");

    try {
        // 2. Obtener Hardware por SSH
        const hw = await getHardwareStats();

        // 3. Obtener Lista de Servidores desde Pterodactyl API
        const response = await fetch(`${host}/api/client`, {
            method: 'GET',
            headers: { 
                'Authorization': `Bearer ${key}`, 
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });
        const data = await response.json();
        const servers = data.data; // Aquí están todos tus servidores

        // 4. Borrar mensaje de espera
        bot.deleteMessage(chatId, loadingMsg.message_id);

        // 5. Crear botones dinámicos para cada servidor
        const inline_keyboard = [];
        servers.forEach(s => {
            const srv = s.attributes;
            // Añadimos una fila de botones por cada servidor encontrado
            inline_keyboard.push([
                { text: `▶️ ${srv.name} (Start)`, callback_data: `pwr_start_${srv.identifier}` },
                { text: `🔄 Reset`, callback_data: `pwr_restart_${srv.identifier}` },
                { text: `⏹ Stop`, callback_data: `pwr_stop_${srv.identifier}` }
            ]);
        });

        const panel = `🖥 **HOST MONITOR: Intel i5-6400**\n` +
                      `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n` +
                      `🌡 **CPU Temp:** \`${hw.cpuTemp}°C\`\n` +
                      `🎮 **GPU Temp:** \`${hw.gpuTemp}°C\`\n` +
                      `📟 **RAM Global:** \`${hw.ramUsed}MB / ${hw.ramTotal}MB\`\n` +
                      `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n` +
                      `_Hardware: MSI B150M BAZOOKA_`;

        bot.sendMessage(chatId, panel, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: inline_keyboard }
        });

    } catch (err) {
        console.error(err);
        bot.sendMessage(chatId, "❌ Error al cargar datos: " + err.message);
    }
});

// --- ACCIONES DE BOTONES ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const [_, action, srvId] = query.data.split('_');

    if (query.data.startsWith('pwr_')) {
        bot.answerCallbackQuery(query.id, { text: `Enviando ${action}...` });

        try {
            await fetch(`${host}/api/client/servers/${srvId}/power`, {
                method: 'POST',
                headers: { 
                    'Authorization': `Bearer ${key}`, 
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({ signal: action })
            });

            // Actualizamos la temperatura después de la acción
            const hw = await getHardwareStats();
            
            bot.editMessageText(
                `🖥 **HOST MONITOR: Intel i5-6400**\n` +
                `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n` +
                `✅ Acción \`${action.toUpperCase()}\` enviada.\n\n` +
                `🌡 **CPU Temp:** \`${hw.cpuTemp}°C\`\n` +
                `🎮 **GPU Temp:** \`${hw.gpuTemp}°C\`\n` +
                `📟 **RAM Global:** \`${hw.ramUsed}MB / ${hw.ramTotal}MB\`\n` +
                `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n` +
                `_Hardware: MSI B150M BAZOOKA_`,
                { 
                    chat_id: chatId, 
                    message_id: messageId, 
                    parse_mode: 'Markdown', 
                    reply_markup: query.message.reply_markup 
                }
            );
        } catch (err) {
            bot.sendMessage(chatId, "❌ Error en Pterodactyl: " + err.message);
        }
    }
});

console.log("Bot iniciado con éxito...");
