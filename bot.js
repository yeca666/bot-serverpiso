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

const ADMIN_PASSWORD = "adminpiso423"; 
let awaitingAuth = {}; 

const bot = new TelegramBot(token, { polling: true });

// Función para crear la barra de progreso visual
function drawBar(percentage) {
    const size = 10;
    const dots = Math.round((percentage / 100) * size);
    const empty = size - dots;
    return "[" + "⣿".repeat(dots) + "⣀".repeat(empty) + "]";
}

// --- FUNCIÓN SSH (Hardware + RAM + Uptime + Disco) ---
function getHardwareStats() {
    return new Promise((resolve) => {
        const conn = new Client();
        conn.on('ready', () => {
            // Comandos para sensores, ram, uptime y disco (raíz /)
            conn.exec("sensors && free -m && uptime -p && df -h /", (err, stream) => {
                if (err) return resolve(null);
                let output = '';
                stream.on('data', (d) => output += d).on('close', () => {
                    const tempMatch = output.match(/Package id 0:\s+\+([\d.]+)/);
                    const gpuMatch = output.match(/GPU core:\s+.*?temp1:\s+\+([\d.]+)/s);
                    const ramLine = output.match(/Mem:\s+(\d+)\s+(\d+)/);
                    const uptimeMatch = output.match(/up\s+(.*)/);
                    const diskLine = output.match(/\/dev\/.*?\s+(\d+\w)\s+(\d+\w)\s+(\d+\w)\s+(\d+)%/);
                    
                    let ramPct = 0;
                    if (ramLine) {
                        ramPct = ((parseInt(ramLine[2]) / parseInt(ramLine[1])) * 100).toFixed(1);
                    }

                    let upTime = uptimeMatch ? uptimeMatch[1].replace(/hours|hour/, 'h').replace(/minutes|minute/, 'm').replace(/days|day/, 'd').replace(/,/g, '') : "??";
                    
                    resolve({
                        cpu: tempMatch ? tempMatch[1] : "??",
                        gpu: gpuMatch ? gpuMatch[1] : "??",
                        ramP: ramPct,
                        up: upTime,
                        diskP: diskLine ? diskLine[4] : "0"
                    });
                    conn.end();
                });
            });
        }).on('error', () => resolve(null))
          .connect({ host: sshHost, port: 2222, username: sshUser, password: sshPass });
    });
}

// --- ESCUCHA DE MENSAJES (Contraseña) ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (awaitingAuth[chatId]) {
        const { action, panelId, promptId } = awaitingAuth[chatId];
        if (msg.text === ADMIN_PASSWORD) {
            try {
                await bot.deleteMessage(chatId, panelId);
                await bot.deleteMessage(chatId, promptId);
                await bot.deleteMessage(chatId, msg.message_id);
            } catch (e) {}
            delete awaitingAuth[chatId];
            
            const conn = new Client();
            conn.on('ready', () => {
                conn.exec(`sudo /usr/sbin/${action}`, () => setTimeout(() => conn.end(), 1000));
            }).connect({ host: sshHost, port: 2222, username: sshUser, password: sshPass });
        } else {
            delete awaitingAuth[chatId];
            bot.sendMessage(chatId, "❌ Contraseña incorrecta.");
        }
    }
});

// --- COMANDO /START ---
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const loading = await bot.sendMessage(chatId, "⏳ Sincronizando i5-6400...");

    try {
        const res = await fetch(`${host}/api/client`, { headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' } });
        const data = await res.json();
        const hw = await getHardwareStats();
        bot.deleteMessage(chatId, loading.message_id);

        const keyboard = data.data.map(s => [
            { text: `▶️ Start ${s.attributes.name}`, callback_data: `pwr_start_${s.attributes.identifier}` },
            { text: `🔄 Restart`, callback_data: `pwr_restart_${s.attributes.identifier}` },
            { text: `⏹ Stop`, callback_data: `pwr_stop_${s.attributes.identifier}` }
        ]);

        keyboard.push([
            { text: "🚀 Test Velocidad", callback_data: "sys_speedtest" },
            { text: "🛰️ Reboot Host", callback_data: "sys_reboot" },
            { text: "💀 Apagar Host", callback_data: "sys_poweroff" }
        ]);

        const statsTexto = hw 
            ? `🌡 **CPU:** \`${hw.cpu}°C\`  🎮 **GPU:** \`${hw.gpu}°C\`\n` +
              `📟 **RAM:** \`${hw.ramP}%\`  ⏱ **UP:** \`${hw.up}\`\n` +
              `💾 **DISCO:** \`${hw.diskP}%\` ${drawBar(hw.diskP)}`
            : `⚠️ _Error de hardware_`;

        await bot.sendMessage(chatId, `🖥 **HOST MONITOR**\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n${statsTexto}`, {
            parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard }
        });
    } catch (e) { bot.sendMessage(chatId, "❌ Error de conexión."); }
});

// --- ACCIONES DE BOTONES ---
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data === 'sys_speedtest') {
        bot.answerCallbackQuery(query.id, { text: "Iniciando test... espera unos 20s." });
        const testingMsg = await bot.sendMessage(chatId, "🌐 Realizando Speedtest desde el i5-6400...");
        
        const conn = new Client();
        conn.on('ready', () => {
            conn.exec("speedtest-cli --simple", (err, stream) => {
                let res = '';
                stream.on('data', (d) => res += d).on('close', () => {
                    bot.editMessageText(`✅ **Resultado Speedtest:**\n\`\`\`\n${res}\`\`\``, {
                        chat_id: chatId, message_id: testingMsg.message_id, parse_mode: 'Markdown'
                    });
                    conn.end();
                });
            });
        }).connect({ host: sshHost, port: 2222, username: sshUser, password: sshPass });
        return;
    }

    if (data.startsWith('sys_')) {
        const action = data.split('_')[1];
        const prompt = await bot.sendMessage(chatId, `🔐 Autorización para **${action}**.\nEscribe la contraseña:`);
        awaitingAuth[chatId] = { action: action, panelId: query.message.message_id, promptId: prompt.message_id };
        bot.answerCallbackQuery(query.id);
        return;
    }

    if (data.startsWith('pwr_')) {
        const [_, action, srvId] = data.split('_');
        bot.answerCallbackQuery(query.id, { text: `Enviando ${action}...` });
        fetch(`${host}/api/client/servers/${srvId}/power`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ signal: action })
        }).catch(() => bot.sendMessage(chatId, "❌ Error de señal."));
    }
});
