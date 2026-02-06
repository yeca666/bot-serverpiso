const TelegramBot = require('node-telegram-bot-api');
const { Client } = require('ssh2'); 
const Nodeactyl = require('nodeactyl');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// --- VARIABLES ---
const token = process.env.token;
const host = process.env.host; 
const key = process.env.key;
const sshUser = process.env.ssh_user; 
const sshPass = process.env.ssh_pass;
const sshHost = '92.185.36.177';

const bot = new TelegramBot(token, { polling: true });
const ptero = new Nodeactyl.NodeactylClient(host, key);

// --- FUNCIÓN SSH (PUERTO 2222) ---
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
    
    // 1. Enviamos mensaje de espera (el aviso pequeño)
    const loadingMsg = await bot.sendMessage(chatId, "⏳ Conectando al servidor, espera...");

    try {
        // 2. Obtenemos hardware real y lista de servidores
        const hw = await getHardwareStats();
        const servers = await ptero.getAllServers();
        
        // 3. Borramos el mensaje de "espera" para poner el panel real
        bot.deleteMessage(chatId, loadingMsg.message_id);

        const buttons = servers.map(s => [
            { text: `▶️ Start ${s.name}`, callback_data: `pwr_start_${s.identifier}` },
            { text: `🔄 Restart ${s.name}`, callback_data: `pwr_restart_${s.identifier}` },
            { text: `⏹ Stop ${s.name}`, callback_data: `pwr_stop_${s.identifier}` }
        ]);

        const panel = `🖥 **HOST MONITOR: Intel i5-6400**\n` +
                      `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n` +
                      `🌡 **CPU Temp:** \`${hw.cpuTemp}°C\`\n` +
                      `🎮 **GPU Temp:** \`${hw.gpuTemp}°C\`\n` +
                      `📟 **RAM Global:** \`${hw.ramUsed}MB / ${hw.ramTotal}MB\`\n` +
                      `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n` +
                      `_Hardware: MSI B150M BAZOOKA_`;

        bot.sendMessage(chatId, panel, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });

    } catch (err) {
        bot.editMessageText(`❌ Error al conectar: ${err.message}`, {
            chat_id: chatId,
            message_id: loadingMsg.message_id
        });
    }
});

// --- ACCIONES DE BOTONES ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const [_, action, srvId] = query.data.split('_');

    if (query.data.startsWith('pwr_')) {
        // Mensaje de alerta en el centro de la pantalla
        bot.answerCallbackQuery(query.id, { text: "Ejecutando acción en Pterodactyl...", show_alert: false });

        try {
            // Enviamos la señal al servidor
            await fetch(`${host}/api/client/servers/${srvId}/power`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ signal: action })
            });

            // Actualizamos el hardware en el mismo mensaje para que se vea el cambio
            const hw = await getHardwareStats();
            
            bot.editMessageText(
                `🖥 **HOST MONITOR: Intel i5-6400**\n` +
                `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n` +
                `✅ Acción \`${action.toUpperCase()}\` enviada con éxito.\n\n` +
                `🌡 **CPU Temp:** \`${hw.cpuTemp}°C\`\n` +
                `🎮 **GPU Temp:** \`${hw.gpuTemp}°C\`\n` +
                `📟 **RAM Global:** \`${hw.ramUsed}MB / ${hw.ramTotal}MB\`\n` +
                `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n` +
                `_Hardware: MSI B150M BAZOOKA_`,
                { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: query.message.reply_markup }
            );
        } catch (err) {
            bot.sendMessage(chatId, "❌ Error al ejecutar acción: " + err.message);
        }
    }
});

console.log("Bot iniciado correctamente...");
