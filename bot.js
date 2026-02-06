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

const ADMIN_PASSWORD = "adminpiso423"; // La contraseña que pedirá el bot
let awaitingAuth = {}; // Aquí guardaremos quién ha pulsado el botón y qué quería hacer

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

// --- ESCUCHA DE MENSAJES DE TEXTO (Para la contraseña) ---
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Si este usuario había pulsado un botón de sistema hace poco...
    if (awaitingAuth[chatId]) {
        if (text === ADMIN_PASSWORD) {
            const action = awaitingAuth[chatId];
            delete awaitingAuth[chatId]; // Limpiar estado
            
            bot.sendMessage(chatId, `✅ Contraseña correcta. Ejecutando ${action}...`);
            ejecutarComandoSistema(chatId, action);
        } else {
            delete awaitingAuth[chatId]; // Si falla, cancelamos el proceso por seguridad
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
            bot.sendMessage(chatId, `⚠️ Servidor físico ${action === 'reboot' ? 'reiniciándose' : 'apagándose'}...`);
            setTimeout(() => conn.end(), 2000);
        });
    }).connect({ host: sshHost, port: 2222, username: sshUser, password: sshPass });
}

// --- COMANDO /START ---
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const loading = await bot.sendMessage(chatId, "⏳ Conectando...");

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

        // Botones de sistema (Ahora visibles para todos)
        keyboard.push([
            { text: "🛰️ Reiniciar Host", callback_data: "sys_reboot" },
            { text: "💀 APAGAR HOST", callback_data: "sys_poweroff" }
        ]);

        const statsTexto = hw 
            ? `🌡 **CPU:** \`${hw.cpu}°C\`  🎮 **GPU:** \`${hw.gpu}°C\`\n📟 **RAM:** \`${hw.ramU}MB / ${hw.ramT}MB\``
            : `⚠️ _No se pudo leer el hardware_`;

        bot.sendMessage(chatId, `🖥 **HOST MONITOR**\n${statsTexto}`, {
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

    if (data.startsWith('sys_')) {
        const action = data.split('_')[1];
        awaitingAuth[chatId] = action; // Guardamos qué quiere hacer el usuario
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId, `🔐 Se requiere autorización para **${action}**.\nEscribe la contraseña de administrador:`);
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
