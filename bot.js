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

// --- FUNCIÓN SSH (Hardware con cálculo de %) ---
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
                    
                    let ramPct = "??";
                    if (ramLine) {
                        const total = parseInt(ramLine[1]);
                        const used = parseInt(ramLine[2]);
                        ramPct = ((used / total) * 100).toFixed(1); // Un decimal para precisión
                    }

                    resolve({
                        cpu: tempMatch ? tempMatch[1] : "??",
                        gpu: gpuMatch ? gpuMatch[1] : "??",
                        ramP: ramPct
                    });
                    conn.end();
                });
            });
        }).on('error', () => resolve(null))
          .connect({ host: sshHost, port: 2222, username: sshUser, password: sshPass, readyTimeout: 10000 });
    });
}

// --- ESCUCHA DE MENSAJES DE TEXTO (Contraseña y Limpieza) ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (awaitingAuth[chatId]) {
        const { action, panelId, promptId } = awaitingAuth[chatId];

        if (text === ADMIN_PASSWORD) {
            bot.sendMessage(chatId, `✅ Código aceptado. Ejecutando ${action}...`);
            
            try {
                await bot.deleteMessage(chatId, panelId);
                await bot.deleteMessage(chatId, promptId);
                await bot.deleteMessage(chatId, msg.message_id); 
            } catch (e) { console.log("Error al limpiar chat"); }

            delete awaitingAuth[chatId];
            ejecutarComandoSistema(chatId, action);
        } else {
            delete awaitingAuth[chatId];
            bot.sendMessage(chatId, "❌ Contraseña incorrecta. Operación cancelada.");
        }
    }
});

// --- FUNCIÓN PARA EJECUTAR SSH ---
function ejecutarComandoSistema(chatId, action) {
    const conn = new Client();
    conn.on('ready', () => {
        conn.exec(`sudo /usr/sbin/${action}`, (err, stream) => {
            if (err) return bot.sendMessage(chatId, "❌ Error de SSH.");
            bot.sendMessage(chatId, `💀 **HOST ${action.toUpperCase()}**\n_Cerrando conexión._`);
            setTimeout(() => conn.end(), 2000);
        });
    }).connect({ host: sshHost, port: 2222, username: sshUser, password: sshPass });
}

// --- COMANDO /START ---
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const loading = await bot.sendMessage(chatId, "⏳ Obteniendo estado del Host...");

    try {
        const res = await fetch(`${host}/api/client`, {
            headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' }
        });
        const data = await res.json();
        const servers = data.data;
        const hw = await getHardwareStats();

        bot.deleteMessage(chatId, loading.message_id);

        const keyboard = servers.map(s => [
            { text: `▶️ Start ${s.attributes.name}`, callback_data: `pwr_start_${s.attributes.identifier}` },
            { text: `🔄 Restart`, callback_data: `pwr_restart_${s.attributes.identifier}` },
            { text: `⏹ Stop`, callback_data: `pwr_stop_${s.attributes.identifier}` }
        ]);

        keyboard.push([
            { text: "🛰️ Reiniciar Host", callback_data: "sys_reboot" },
            { text: "💀 APAGAR HOST", callback_data: "sys_poweroff" }
        ]);

        const statsTexto = hw 
            ? `🌡 **CPU:** \`${hw.cpu}°C\`  🎮 **GPU:** \`${hw.gpu}°C\`\n📟 **RAM en uso:** \`${hw.ramP}%\``
            : `⚠️ _No se pudo leer el hardware_`;

        await bot.sendMessage(chatId, `🖥 **HOST MONITOR: i5-6400**\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n${statsTexto}`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });

    } catch (e) {
        bot.sendMessage(chatId, "❌ Error de conexión.");
    }
});

// --- ACCIONES DE BOTONES ---
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    if (data.startsWith('sys_')) {
        const action = data.split('_')[1];
        const prompt = await bot.sendMessage(chatId, `🔐 Autorización para **${action}**.\nEscribe la contraseña de admin:`);
        
        awaitingAuth[chatId] = { 
            action: action, 
            panelId: messageId, 
            promptId: prompt.message_id 
        };
        bot.answerCallbackQuery(query.id);
        return;
    }

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
            bot.sendMessage(chatId, "❌ Error de señal.");
        }
    }
});
