const TelegramBot = require('node-telegram-bot-api');
const { Client } = require('ssh2'); 
const Nodeactyl = require('nodeactyl');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const token = process.env.token;
const host = process.env.host; 
const key = process.env.key;

console.log("--- INICIANDO BOT ---");
console.log("Token detectado:", process.env.token ? "SÍ" : "NO");

bot.on('polling_error', (error) => {
    console.log("ERROR DE POLLING:", error.code); 
});

bot.getMe().then((me) => {
    console.log("Conectado exitosamente como:", me.username);
}).catch((err) => {
    console.log("Fallo al conectar con Telegram:", err.message);
});

// NUEVAS VARIABLES PARA SSH (Añádelas en Northflank)
const sshUser = process.env.ssh_user; 
const sshPass = process.env.ssh_pass;
const sshHost = '92.185.36.177';

const bot = new TelegramBot(token, { polling: true });
const client = new Nodeactyl.NodeactylClient(host, key);

// Función mágica para leer el hardware real
function getHardwareStats() {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        conn.on('ready', () => {
            // Ejecutamos sensors y comandos de sistema para RAM global
            conn.exec("sensors && free -m", (err, stream) => {
                if (err) return reject(err);
                let output = '';
                stream.on('data', (d) => output += d).on('close', () => {
                    // Extraemos la temperatura del Package id 0 usando Regex
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
        }).connect({ host: sshHost, port: 3333, username: sshUser, password: sshPass });
    });
}

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const [_, action, srvId] = query.data.split('_');

    if (query.data.startsWith('pwr_')) {
        bot.answerCallbackQuery(query.id, { text: "Accediendo al Host..." });
        
        try {
            // 1. Obtenemos datos del hardware real por SSH
            const hw = await getHardwareStats();
            
            // 2. Enviamos la orden a Pterodactyl
            await fetch(`${host}/api/client/servers/${srvId}/power`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ signal: action })
            });

            // 3. Editamos el mensaje con el diseño final
            bot.editMessageText(
                `🖥 **HOST MONITOR: Intel i5-6400**\n` +
                `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n` +
                `🚀 Acción: \`${action.toUpperCase()}\` enviada.\n\n` +
                `🌡 **CPU Temp:** \`${hw.cpuTemp}°C\`\n` +
                `🎮 **GPU Temp:** \`${hw.gpuTemp}°C\`\n` +
                `📟 **RAM Global:** \`${hw.ramUsed}MB / ${hw.ramTotal}MB\`\n` +
                `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n` +
                `_Hardware: MSI B150M BAZOOKA_`,
                { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }
            );
        } catch (err) {
            bot.sendMessage(chatId, "❌ Error de conexión SSH: " + err.message);
        }
    }
});


