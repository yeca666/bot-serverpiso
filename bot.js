const TelegramBot = require('node-telegram-bot-api');
const { Client } = require('ssh2');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// --- CONFIGURACIÓN ---
const token = process.env.token;
const host = process.env.host;
const key = process.env.key;
const sshUser = process.env.ssh_user; 
const sshPass = process.env.ssh_pass;
const sshHost = process.env.ssh_host || 'serverpiso.duckdns.org';
const miChatId = 1102386887; // CAMBIA ESTO por tu ID real para el aviso de inicio

const ADMIN_PASSWORD = "adminpiso423"; 
let awaitingAuth = {}; 

const bot = new TelegramBot(token, { polling: true });

// --- AVISO DE INICIO ---
bot.sendMessage(miChatId, "✅ **¡SISTEMA ONLINE!** El i5-6400 está operativo.", { parse_mode: 'Markdown' });

// --- FUNCIÓN PARA LIMPIAR CHAT ---
async function limpiarHistorial(chatId, lastMsgId) {
    // Intenta borrar los últimos 50 mensajes desde el actual hacia atrás
    for (let i = 0; i < 50; i++) {
        try {
            await bot.deleteMessage(chatId, lastMsgId - i);
        } catch (e) {
            // Si falla (mensaje muy viejo o ya borrado), simplemente sigue
        }
    }
}

function drawBar(percentage) {
    const size = 10;
    const dots = Math.round((percentage / 100) * size);
    const empty = size - dots;
    return "[" + "⣿".repeat(dots) + "⣀".repeat(empty) + "]";
}

// --- FUNCIÓN SSH ---
function getHardwareStats() {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        conn.on('ready', () => {
            const cmd = "sensors && free -m && uptime -p && df -h / && ping -c 1 8.8.8.8 && ip -h -s link";
            conn.exec(cmd, (err, stream) => {
                if (err) return reject(err);
                let output = '';
                stream.on('data', (d) => output += d).on('close', () => {
                    const tempMatch = output.match(/Package id 0:\s+\+([\d.]+)/);
                    const gpuMatch = output.match(/GPU core:\s+.*?temp1:\s+\+([\d.]+)/s);
                    const ramLine = output.match(/Mem:\s+(\d+)\s+(\d+)/);
                    const uptimeMatch = output.match(/up\s+(.*)/);
                    const diskLine = output.match(/\/dev\/.*?\s+(\d+\w)\s+(\d+\w)\s+(\d+\w)\s+(\d+)%/);
                    const pingMatch = output.match(/time=([\d.]+)\s+ms/);
                    const netMatch = output.match(/RX:\s+bytes\s+packets.*?\s+([\d.]+\w)\s+.*?TX:\s+bytes\s+packets.*?\s+([\d.]+\w)/s);

                    let ramPct = ramLine ? ((parseInt(ramLine[2]) / parseInt(ramLine[1])) * 100).toFixed(1) : "0";
                    let upTime = uptimeMatch ? uptimeMatch[1].replace(/hours|hour/, 'h').replace(/minutes|minute/, 'm').replace(/days|day/, 'd').replace(/,/g, '') : "??";
                    
                    resolve({
                        cpu: tempMatch ? tempMatch[1] : "??",
                        gpu: gpuMatch ? gpuMatch[1] : "??",
                        ramP: ramPct,
                        up: upTime,
                        diskP: diskLine ? diskLine[4] : "0",
                        ping: pingMatch ? pingMatch[1] : "??",
                        rx: netMatch ? netMatch[1] : "??",
                        tx: netMatch ? netMatch[2] : "??"
                    });
                    conn.end();
                });
            });
        }).on('error', reject).connect({ host: sshHost, port: 2222, username: sshUser, password: sshPass, readyTimeout: 5000 });
    });
}

// --- COMANDO /START ---
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    // Primero: Limpiamos lo que haya detrás
    await limpiarHistorial(chatId, msg.message_id);

    const loading = await bot.sendMessage(chatId, "⏳ Sincronizando i5-6400...");

    try {
        const hw = await getHardwareStats();
        const res = await fetch(`${host}/api/client`, { headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' } });
        const data = await res.json();
        
        await bot.deleteMessage(chatId, loading.message_id);

        const keyboard = data.data.map(s => [
            { text: `▶️ Start ${s.attributes.name}`, callback_data: `pwr_start_${s.attributes.identifier}` },
            { text: `🔄 Restart`, callback_data: `pwr_restart_${s.attributes.identifier}` },
            { text: `⏹ Stop`, callback_data: `pwr_stop_${s.attributes.identifier}` }
        ]);

        keyboard.push([
            { text: "🔥 Top Procesos", callback_data: "sys_top" },
            { text: "🚀 Speedtest", callback_data: "sys_speedtest" }
        ]);
        keyboard.push([
            { text: "🛰️ Reboot", callback_data: "sys_reboot" },
            { text: "💀 Apagar", callback_data: "sys_poweroff" }
        ]);

        const statsTexto = `🌡 **CPU:** \`${hw.cpu}°C\`  🎮 **GPU:** \`${hw.gpu}°C\`\n` +
                           `📟 **RAM:** \`${hw.ramP}%\`  ⏱ **UP:** \`${hw.up}\`\n` +
                           `💾 **DISCO:** \`${hw.diskP}%\` ${drawBar(hw.diskP)}\n` +
                           `🌐 **RED:** \`${hw.ping}ms\` | ⬇️ \`${hw.rx}\` ⬆️ \`${hw.tx}\``;

        await bot.sendMessage(chatId, `🖥 **HOST MONITOR**\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n${statsTexto}`, {
            parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard }
        });
    } catch (e) {
        try { await bot.deleteMessage(chatId, loading.message_id); } catch(err) {}
        bot.sendMessage(chatId, "🔴 **El servidor Host se encuentra apagado o no es accesible.**");
    }
});

// --- ACCIONES DE BOTONES (Top, Speedtest, etc) ---
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data === 'sys_top') {
        bot.answerCallbackQuery(query.id);
        const conn = new Client();
        conn.on('ready', () => {
            conn.exec("ps -eo pcpu,comm --sort=-pcpu | head -n 4 | tail -n 3", (err, stream) => {
                let res = '';
                stream.on('data', (d) => res += d).on('close', () => {
                    bot.sendMessage(chatId, `🔥 **TOP 3 PROCESOS:**\n\`\`\`\n%CPU  CMD\n${res}\`\`\``, { parse_mode: 'Markdown' });
                    conn.end();
                });
            });
        }).connect({ host: sshHost, port: 2222, username: sshUser, password: sshPass });
        return;
    }

    if (data === 'sys_speedtest') {
        bot.answerCallbackQuery(query.id, { text: "Ejecutando (20s)..." });
        const testingMsg = await bot.sendMessage(chatId, "🌐 Realizando Speedtest...");
        const conn = new Client();
        conn.on('ready', () => {
            conn.exec("speedtest-cli --simple", (err, stream) => {
                let res = '';
                stream.on('data', (d) => res += d).on('close', () => {
                    bot.editMessageText(`✅ **Resultado Speedtest:**\n\`\`\`\n${res}\`\`\``, { chat_id: chatId, message_id: testingMsg.message_id, parse_mode: 'Markdown' });
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
});

// --- LÓGICA DE CONTRASEÑA ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (awaitingAuth[chatId] && msg.text === ADMIN_PASSWORD) {
        const { action, panelId, promptId } = awaitingAuth[chatId];
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
    }
});
