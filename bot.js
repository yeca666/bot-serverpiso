const TelegramBot = require('node-telegram-bot-api');
const { Client } = require('ssh2'); 
const Nodeactyl = require('nodeactyl');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// --- CONFIGURACIÓN DE VARIABLES ---
const token = process.env.token;
const host = process.env.host; 
const key = process.env.key;
const sshUser = process.env.ssh_user; 
const sshPass = process.env.ssh_pass;
const sshHost = '92.185.36.177'; // Tu IP pública

// --- INICIALIZACIÓN ---
const bot = new TelegramBot(token, { polling: true });
const client = new Nodeactyl.NodeactylClient(host, key);

// --- LOGS DE DIAGNÓSTICO (Para ver en Northflank) ---
console.log("--- INICIANDO SISTEMA DE MONITOREO ---");
console.log("Configuración cargada: ", {
    token: token ? "OK" : "FALTA",
    ptero_host: host ? "OK" : "FALTA",
    ssh_user: sshUser ? "OK" : "FALTA"
});

bot.getMe().then((me) => {
    console.log(`✅ Bot conectado como: @${me.username}`);
}).catch((err) => {
    console.log("❌ Error de conexión con Telegram:", err.message);
});

bot.on('polling_error', (err) => {
    console.log("⚠️ Error de Polling (Telegram):", err.code);
});

// --- FUNCIÓN SSH PARA HARDWARE REAL ---
function getHardwareStats() {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        conn.on('ready', () => {
            // Ejecutamos comandos para ver temperatura y RAM
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
        }).on('error', (err) => {
            reject(err);
        }).connect({ 
            host: sshHost, 
            port: 2222, // El puerto que abriste en el router
            username: sshUser, 
            password: sshPass,
            readyTimeout: 10000 
        });
    });
}

// --- COMANDO /STATUS ---
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const serverId = "TU_ID_AQUÍ"; // Pon aquí el ID de un servidor para los botones, o lo buscamos luego

    const opts = {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '▶️ Start', callback_data: `pwr_start_${serverId}` },
                    { text: '🔄 Restart', callback_data: `pwr_restart_${serverId}` }
                ],
                [
                    { text: '⏹ Stop', callback_data: `pwr_stop_${serverId}` }
                ]
            ]
        }
    };

    bot.sendMessage(chatId, "🖥 **Panel de Control de Host**\nSelecciona una acción para leer el hardware real:", opts);
});

// --- MANEJO DE BOTONES ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data.split('_');
    const action = data[1];
    const srvId = data[2];

    if (query.data.startsWith('pwr_')) {
        bot.answerCallbackQuery(query.id, { text: "Conectando al servidor físico..." });
        
        try {
            // 1. SSH al i5-6400
            const hw = await getHardwareStats();
            
            // 2. Acción en Pterodactyl
            if (srvId !== "TU_ID_AQUÍ") {
                await fetch(`${host}/api/client/servers/${srvId}/power`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ signal: action })
                });
            }

            // 3. Respuesta visual
            bot.editMessageText(
                `🖥 **HOST MONITOR: Intel i5-6400**\n` +
                `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n` +
                `🚀 Acción: \`${action.toUpperCase()}\` ejecutada.\n\n` +
                `🌡 **CPU Temp:** \`${hw.cpuTemp}°C\`\n` +
                `🎮 **GPU Temp:** \`${hw.gpuTemp}°C\`\n` +
                `📟 **RAM Global:** \`${hw.ramUsed}MB / ${hw.ramTotal}MB\`\n` +
                `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n` +
                `_Hardware: MSI B150M BAZOOKA_`,
                { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }
            );
        } catch (err) {
            console.log("Error en el proceso:", err.message);
            bot.sendMessage(chatId, "❌ Error: " + err.message);
        }
    }
});

