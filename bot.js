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

// --- FUNCIÓN SSH (Hardware) ---
function getHardwareStats() {
    return new Promise((resolve) => {
        const conn = new Client();
        conn.on('ready', () => {
            conn.exec("sensors && free -m", (err, stream) => {
                if (err) return resolve(null);
                let output = '';
                stream.on('data', (d) => output += d).on('close', () => {
                    const tempMatch = output.match(/Package id 0:\s+\+([\d.]+)/);
                    const gpuMatch = output.match(/GPU core:\s+.*?temp1:\s+\+([\d.]+)/s);
                    const ramLine = output.match(/Mem:\s+(\d+)\s+(\d+)/);
                    resolve({
                        cpu: tempMatch ? tempMatch[1] : "??",
                        gpu: gpuMatch ? gpuMatch[1] : "??",
                        ramU: ramLine ? ramLine[2] : "??",
                        ramT: ramLine ? ramLine[1] : "??"
                    });
                    conn.end();
                });
            });
        }).on('error', () => resolve(null))
          .connect({ host: sshHost, port: 2222, username: sshUser, password: sshPass, readyTimeout: 10000 });
    });
}

// --- COMANDO /START ---
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    const loading = await bot.sendMessage(chatId, "⏳ Conectando al servidor físico...");

    try {
        const res = await fetch(`${host}/api/client`, {
            headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' }
        });
        const data = await res.json();
        const servers = data.data;

        const hw = await getHardwareStats();

        bot.deleteMessage(chatId, loading.message_id);

        // 1. Botones de Pterodactyl (Tus servidores de juegos)
        const keyboard = servers.map(s => [
            { text: `▶️ Start ${s.attributes.name}`, callback_data: `pwr_start_${s.attributes.identifier}` },
            { text: `🔄 Restart`, callback_data: `pwr_restart_${s.attributes.identifier}` },
            { text: `⏹ Stop`, callback_data: `pwr_stop_${s.attributes.identifier}` }
        ]);

        // 2. AÑADIMOS FILA DE SISTEMA AL FINAL
        keyboard.push([
            { text: "🛰️ Reiniciar Host", callback_data: "sys_reboot" },
            { text: "💀 APAGAR HOST", callback_data: "sys_poweroff" }
        ]);

        const statsTexto = hw 
            ? `🌡 **CPU:** \`${hw.cpu}°C\`  🎮 **GPU:** \`${hw.gpu}°C\`\n📟 **RAM:** \`${hw.ramU}MB / ${hw.ramT}MB\``
            : `⚠️ _No se pudo leer el hardware por SSH_`;

        const panel = `🖥 **HOST MONITOR: Intel i5-6400**\n` +
                      `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n` +
                      `${statsTexto}\n` +
                      `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n` +
                      `_Hardware: MSI B150M BAZOOKA_`;

        bot.sendMessage(chatId, panel, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });

    } catch (e) {
        bot.sendMessage(chatId, "❌ Error crítico: No se pudo conectar con Pterodactyl.");
    }
});

// --- ACCIONES DE BOTONES ---
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    // LÓGICA PARA EL HOST (NUEVA)
    if (data.startsWith('sys_')) {
        const action = data.split('_')[1]; // reboot o poweroff
        bot.answerCallbackQuery(query.id, { text: `Ejecutando ${action}...` });
        
        const conn = new Client();
        conn.on('ready', () => {
            conn.exec(`sudo ${action}`, (err, stream) => {
                if (err) return bot.sendMessage(chatId, "❌ Error de SSH.");
                bot.sendMessage(chatId, `⚠️ Orden enviada: El host se está ${action === 'reboot' ? 'reiniciando' : 'apagando'}.`);
                conn.end();
            });
        }).connect({ host: sshHost, port: 2222, username: sshUser, password: sshPass });
        return;
    }

    // LÓGICA PARA PTERODACTYL (LA QUE YA TENÍAS)
    if (data.startsWith('pwr_')) {
        const [_, action, srvId] = data.split('_');
        bot.answerCallbackQuery(query.id, { text: `Enviando ${action}...` });

        try {
            await fetch(`${host}/api/client/servers/${srvId}/power`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ signal: action })
            });
        } catch (e) {
            bot.sendMessage(chatId, "❌ Error al enviar señal.");
        }
    }
});
