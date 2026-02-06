const TelegramBot = require('node-telegram-bot-api');
const { Client } = require('ssh2');
const Nodeactyl = require('nodeactyl');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const token = process.env.token;
const host = process.env.host;
const key = process.env.key;
const sshUser = process.env.ssh_user;
const sshPass = process.env.ssh_pass;
const sshHost = '92.185.36.177';

const bot = new TelegramBot(token, { polling: true });
const client = new Nodeactyl.NodeactylClient(host, key);

// --- ESTA ES LA FUNCIÓN NUEVA QUE NO DEBE ROMPER NADA ---
function getHardwareStats() {
    return new Promise((resolve) => {
        const conn = new Client();
        conn.on('ready', () => {
            conn.exec("sensors && free -m", (err, stream) => {
                if (err) return resolve({ cpuTemp: "??", gpuTemp: "??", ramUsed: "??", ramTotal: "??" });
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
        }).on('error', () => resolve({ cpuTemp: "Error", gpuTemp: "Error", ramUsed: "Error", ramTotal: "Error" }))
          .connect({ host: sshHost, port: 2222, username: sshUser, password: sshPass, readyTimeout: 10000 });
    });
}

// --- COMANDO START (COMO EL ORIGINAL) ---
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    // Mensaje temporal de carga
    const waitMsg = await bot.sendMessage(chatId, "⏳ Conectando al servidor, espera...");

    try {
        const hw = await getHardwareStats();
        const servers = await client.getAllServers();
        
        // Borramos el "espera"
        bot.deleteMessage(chatId, waitMsg.message_id);

        const buttons = servers.map(s => [
            { text: `▶️ Start ${s.name}`, callback_data: `pwr_start_${s.identifier}` },
            { text: `🔄 Restart ${s.name}`, callback_data: `pwr_restart_${s.identifier}` },
            { text: `⏹ Stop ${s.name}`, callback_data: `pwr_stop_${s.identifier}` }
        ]);

        const texto = `🖥 **HOST MONITOR: Intel i5-6400**\n` +
                      `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n` +
                      `🌡 **CPU Temp:** \`${hw.cpuTemp}°C\`\n` +
                      `🎮 **GPU Temp:** \`${hw.gpuTemp}°C\`\n` +
                      `📟 **RAM Global:** \`${hw.ramUsed}MB / ${hw.ramTotal}MB\`\n` +
                      `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n` +
                      `_Hardware: MSI B150M BAZOOKA_`;

        bot.sendMessage(chatId, texto, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    } catch (e) {
        bot.sendMessage(chatId, "❌ Error al cargar servidores.");
    }
});

// --- ACCIONES (COMO LAS ORIGINALES) ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data.split('_');
    const action = data[1];
    const srvId = data[2];

    if (query.data.startsWith('pwr_')) {
        bot.answerCallbackQuery(query.id, { text: "Procesando..." });
        try {
            await fetch(`${host}/api/client/servers/${srvId}/power`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ signal: action })
            });
            bot.sendMessage(chatId, `✅ Acción ${action} enviada al servidor ${srvId}`);
        } catch (e) {
            bot.sendMessage(chatId, "❌ Error al enviar señal.");
        }
    }
});
