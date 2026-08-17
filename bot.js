const TelegramBot = require('node-telegram-bot-api');
const { Client } = require('ssh2');

const fetch = (...args) =>
    import('node-fetch').then(({ default: fetch }) => fetch(...args));

// ============================================================
// CONFIGURACIÓN
// ============================================================

const token = process.env.token;
const host = process.env.host;
const pteroKey = process.env.key;

const sshUser = process.env.ssh_user;
const sshPass = process.env.ssh_pass;
const sshHost = process.env.ssh_host || 'serverpiso.duckdns.org';

const ADMIN_PASSWORD = process.env.adminpassword;
const GUEST_PASSWORD = process.env.guestpassword;

// TeamSpeak Query
const TS_HOST = process.env.ts_query_host || 'serverpiso.duckdns.org';
const TS_PORT = Number(process.env.ts_query_port || 10022);
const TS_USER = process.env.ts_query_user || 'serveradmin';
const TS_PASS = process.env.ts_query_pass;
const TS_API_KEY = process.env.ts_api_key;
const TS_SERVER_ID = Number(process.env.ts_server_id || 1);
const TS_CHANNEL_ID = Number(process.env.ts_channel_id || 1);

// ============================================================
// BOT
// ============================================================

const bot = new TelegramBot(token, { polling: true });

// Estado de autenticación
const authSessions = {};

// Estado del mini-chat TeamSpeak
const tsChatSessions = {};

// Mensajes temporales
const pendingActions = {};

// ============================================================
// UTILIDADES
// ============================================================

function escapeMarkdown(text) {
    return String(text)
        .replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

function drawBar(percentage, size = 10) {
    const pct = Math.max(0, Math.min(100, Number(percentage) || 0));
    const filled = Math.round((pct / 100) * size);
    return '▰'.repeat(filled) + '▱'.repeat(size - filled);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// LIMPIAR HISTORIAL
// ============================================================

async function limpiarHistorial(chatId, lastMsgId) {
    for (let i = 0; i < 50; i++) {
        try {
            await bot.deleteMessage(chatId, lastMsgId - i);
        } catch (e) {}
    }
}

// ============================================================
// AUTENTICACIÓN
// ============================================================

function isAuthenticated(chatId) {
    return !!authSessions[chatId];
}

function isAdmin(chatId) {
    return authSessions[chatId]?.role === 'admin';
}

function requireAuth(chatId) {
    return isAuthenticated(chatId);
}

function requireAdmin(chatId) {
    return isAdmin(chatId);
}

// ============================================================
// GPU
// ============================================================

async function getGpuTemperature() {
    return new Promise((resolve) => {
        const conn = new Client();

        conn.on('ready', () => {
            conn.exec(
                `if command -v nvidia-smi >/dev/null 2>&1; then
                    nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits 2>/dev/null | head -n 1
                else
                    sensors 2>/dev/null | grep -Ei 'amdgpu|nouveau|radeon|GPU|edge|junction' | head -n 5
                fi`,
                (err, stream) => {
                    if (err) {
                        conn.end();
                        return resolve('N/D');
                    }

                    let output = '';

                    stream.on('data', d => output += d.toString());

                    stream.on('close', () => {
                        conn.end();

                        const nvidia = output.match(/^\s*(\d+(?:\.\d+)?)\s*$/m);

                        if (nvidia) {
                            return resolve(nvidia[1]);
                        }

                        const generic = output.match(/\+?(\d+(?:\.\d+)?)°?C/i);

                        if (generic) {
                            return resolve(generic[1]);
                        }

                        resolve('N/D');
                    });
                }
            );
        });

        conn.on('error', () => resolve('N/D'));

        conn.connect({
            host: sshHost,
            port: 2222,
            username: sshUser,
            password: sshPass,
            readyTimeout: 5000
        });
    });
}

// ============================================================
// ESTADÍSTICAS DEL HOST
// ============================================================

function getHardwareStats() {
    return new Promise((resolve, reject) => {
        const conn = new Client();

        conn.on('ready', () => {

            const cmd = `
                sensors 2>/dev/null;
                free -m;
                uptime -p;
                df -h /;
                ping -c 1 -W 2 8.8.8.8;
                ip -h -s link
            `;

            conn.exec(cmd, (err, stream) => {
                if (err) {
                    conn.end();
                    return reject(err);
                }

                let output = '';

                stream
                    .on('data', d => output += d.toString())
                    .on('close', async () => {

                        const tempMatch =
                            output.match(/Package id 0:\s+\+([\d.]+)/);

                        const ramLine =
                            output.match(/Mem:\s+(\d+)\s+(\d+)/);

                        const uptimeMatch =
                            output.match(/up\s+(.+)/);

                        const diskLine =
                            output.match(
                                /\/dev\/.*?\s+(\d+\w)\s+(\d+\w)\s+(\d+\w)\s+(\d+)%/
                            );

                        const pingMatch =
                            output.match(/time[=<]([\d.]+)\s*ms/);

                        const netMatch =
                            output.match(
                                /RX:\s+bytes\s+packets.*?\s+([\d.]+\w).*?TX:\s+bytes\s+packets.*?\s+([\d.]+\w)/s
                            );

                        let ramPct = '0';

                        if (ramLine) {
                            const total = parseInt(ramLine[1]);
                            const used = parseInt(ramLine[2]);

                            if (total > 0) {
                                ramPct = ((used / total) * 100).toFixed(1);
                            }
                        }

                        let upTime = 'N/D';

                        if (uptimeMatch) {
                            upTime = uptimeMatch[1]
                                .replace(/days?/g, 'd')
                                .replace(/hours?/g, 'h')
                                .replace(/minutes?/g, 'm')
                                .replace(/seconds?/g, 's')
                                .replace(/,/g, '');
                        }

                        const gpu = await getGpuTemperature();

                        resolve({
                            cpu: tempMatch ? tempMatch[1] : 'N/D',
                            gpu,
                            ramP: ramPct,
                            up: upTime,
                            diskP: diskLine ? diskLine[4] : '0',
                            ping: pingMatch ? pingMatch[1] : 'N/D',
                            rx: netMatch ? netMatch[1] : 'N/D',
                            tx: netMatch ? netMatch[2] : 'N/D'
                        });

                        conn.end();
                    });
            });
        });

        conn.on('error', reject);

        conn.connect({
            host: sshHost,
            port: 2222,
            username: sshUser,
            password: sshPass,
            readyTimeout: 5000
        });
    });
}

// ============================================================
// PTERODACTYL
// ============================================================

async function getServers() {
    const res = await fetch(`${host}/api/client`, {
        headers: {
            Authorization: `Bearer ${pteroKey}`,
            Accept: 'application/json'
        }
    });

    if (!res.ok) {
        throw new Error(`Pterodactyl HTTP ${res.status}`);
    }

    const data = await res.json();

    return data.data || [];
}

async function powerServer(serverId, action) {
    return fetch(`${host}/api/client/servers/${serverId}/power`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${pteroKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
        },
        body: JSON.stringify({
            signal: action
        })
    });
}

// ============================================================
// TEAMSPEAK HTTP QUERY
// ============================================================

async function tsRequest(path) {
    const response = await fetch(
        `http://${TS_HOST}:10080/${TS_SERVER_ID}/${path}`,
        {
            headers: {
                'x-api-key': TS_API_KEY,
                Accept: 'application/json'
            }
        }
    );

    if (!response.ok) {
        throw new Error(`TeamSpeak HTTP ${response.status}`);
    }

    return response.json();
}

function decodeTs(value) {
    if (!value) return '';

    return String(value)
        .replace(/\\s/g, ' ')
        .replace(/\\p/g, '|')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\\//g, '/')
        .replace(/\\\\/g, '\\');
}

function splitTsLine(line) {
    const result = [];
    let current = '';
    let escaped = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (escaped) {
            current += '\\' + char;
            escaped = false;
            continue;
        }

        if (char === '\\') {
            escaped = true;
            continue;
        }

        if (char === '|') {
            result.push(current);
            current = '';
            continue;
        }

        current += char;
    }

    if (escaped) current += '\\';

    result.push(current);

    return result;
}

function parseTsFields(line) {
    const fields = {};

    for (const item of splitTsLine(line)) {
        const eq = item.indexOf('=');

        if (eq === -1) continue;

        const key = item.slice(0, eq);
        const value = item.slice(eq + 1);

        fields[key] = decodeTs(value);
    }

    return fields;
}

async function getTsUsers() {
    try {
        const result = await tsRequest('clientlist');

        if (result.status?.code !== 0) {
            return [];
        }

        return (result.body || [])
            .filter(client => client.client_type === '0')
            .filter(client =>
                !String(client.client_nickname || '')
                    .toLowerCase()
                    .includes('bot')
            );
    } catch (e) {
        console.error('TS users:', e.message);
        return [];
    }
}

```javascript
// ============================================================
// TEAMSPEAK SSH CHAT
// ============================================================

function tsEscape(text) {
    return String(text)
        .replace(/\\/g, '\\\\')
        .replace(/\|/g, '\\p')
        .replace(/\//g, '\\/')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/ /g, '\\s');
}

function closeTsChat(chatId) {

    const session = tsChatSessions[chatId];

    if (!session) return;

    console.log(`[TS CHAT] Cerrando sesión Telegram=${chatId}`);

    try {
        if (session.stream) {
            session.stream.write(
                'servernotifyunregister\n'
            );
        }
    } catch (e) {}

    try {
        session.conn.end();
    } catch (e) {}

    delete tsChatSessions[chatId];
}


// ------------------------------------------------------------
// ACTUALIZAR PANEL TELEGRAM
// ------------------------------------------------------------

function updateChatPanel(chatId) {

    const session = tsChatSessions[chatId];

    if (!session || !session.panelId) return;

    const lines = session.messages.length
        ? session.messages
            .slice(-12)
            .map(m => `${m.name}: ${m.text}`)
            .join('\n')
        : '💬 Todavía no hay mensajes nuevos.';

    const text =
        `💬 *CHAT TEAMSPEAK*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `${lines}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `✏️ Escribe un mensaje y se enviará al servidor.\n` +
        `ℹ️ El bot está escuchando el Default Channel.`;

    const keyboard = [
        [
            {
                text: '🔄 Actualizar usuarios',
                callback_data: 'ts_chat_users'
            }
        ],
        [
            {
                text: '🔴 Cerrar chat',
                callback_data: 'ts_chat_close'
            }
        ]
    ];

    bot.editMessageText(text, {
        chat_id: chatId,
        message_id: session.panelId,
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: keyboard
        }
    }).catch(() => {});
}


// ------------------------------------------------------------
// PROCESAR NOTIFICACIONES
// ------------------------------------------------------------

function processTsNotification(chatId, line) {

    const session = tsChatSessions[chatId];

    if (!session) return;

    if (!line.startsWith('notifytextmessage')) {
        return;
    }

    console.log(`[TS NOTIFY] ${line}`);

    const fields = parseTsFields(
        line.replace(/^notifytextmessage\s*/, '')
    );

    const name =
        fields.invokername ||
        fields.invokeruid ||
        'Usuario';

    const message =
        fields.msg || '';

    if (!message) {
        console.log('[TS NOTIFY] Mensaje vacío');
        return;
    }

    console.log(
        `[TS CHAT] ${name}: ${message}`
    );

    session.messages.push({
        name,
        text: message
    });

    if (session.messages.length > 20) {
        session.messages.shift();
    }

    updateChatPanel(chatId);
}


// ------------------------------------------------------------
// OBTENER CLIENT ID DEL SERVERQUERY
// ------------------------------------------------------------

function getQueryClientId(stream) {

    return new Promise((resolve, reject) => {

        let buffer = '';

        const timeout = setTimeout(() => {
            reject(
                new Error(
                    'Timeout obteniendo client_id del ServerQuery'
                )
            );
        }, 5000);

        const onData = data => {

            buffer += data.toString();

            const lines = buffer.split(/\r?\n/);

            buffer = lines.pop() || '';

            for (const line of lines) {

                const clean = line.trim();

                if (!clean) continue;

                console.log(
                    `[TS INIT] ${clean}`
                );

                if (clean.startsWith('clid=')) {

                    const fields =
                        parseTsFields(clean);

                    if (fields.clid) {

                        clearTimeout(timeout);

                        stream.removeListener(
                            'data',
                            onData
                        );

                        resolve(
                            Number(fields.clid)
                        );

                        return;
                    }
                }
            }
        };

        stream.on('data', onData);

        stream.write(
            'clientinfo\n'
        );
    });
}


// ------------------------------------------------------------
// MOVER SERVERQUERY AL CANAL
// ------------------------------------------------------------

function moveQueryToChannel(stream, clid, channelId) {

    return new Promise((resolve, reject) => {

        let buffer = '';

        const timeout = setTimeout(() => {

            stream.removeListener(
                'data',
                onData
            );

            reject(
                new Error(
                    'Timeout moviendo ServerQuery al canal'
                )
            );

        }, 5000);


        const onData = data => {

            buffer += data.toString();

            const lines =
                buffer.split(/\r?\n/);

            buffer = lines.pop() || '';

            for (const line of lines) {

                const clean = line.trim();

                if (!clean) continue;

                console.log(
                    `[TS MOVE] ${clean}`
                );

                if (
                    clean.startsWith('error id=')
                ) {

                    clearTimeout(timeout);

                    stream.removeListener(
                        'data',
                        onData
                    );

                    const fields =
                        parseTsFields(clean);

                    if (fields.id === '0') {

                        resolve();

                    } else {

                        reject(
                            new Error(
                                `TeamSpeak no pudo mover el Query: ${clean}`
                            )
                        );
                    }

                    return;
                }
            }
        };

        stream.on('data', onData);

        stream.write(
            `clientmove clid=${clid} cid=${channelId}\n`
        );
    });
}


// ------------------------------------------------------------
// REGISTRAR EVENTOS DEL CANAL
// ------------------------------------------------------------

function registerTextChannel(stream, channelId) {

    return new Promise((resolve, reject) => {

        let buffer = '';

        const timeout = setTimeout(() => {

            stream.removeListener(
                'data',
                onData
            );

            reject(
                new Error(
                    'Timeout registrando textchannel'
                )
            );

        }, 5000);


        const onData = data => {

            buffer += data.toString();

            const lines =
                buffer.split(/\r?\n/);

            buffer = lines.pop() || '';

            for (const line of lines) {

                const clean = line.trim();

                if (!clean) continue;

                console.log(
                    `[TS REGISTER] ${clean}`
                );

                if (
                    clean.startsWith('error id=')
                ) {

                    clearTimeout(timeout);

                    stream.removeListener(
                        'data',
                        onData
                    );

                    const fields =
                        parseTsFields(clean);

                    if (fields.id === '0') {

                        resolve();

                    } else {

                        reject(
                            new Error(
                                `No se pudo registrar textchannel: ${clean}`
                            )
                        );
                    }

                    return;
                }
            }
        };

        stream.on('data', onData);

        stream.write(
            `servernotifyregister event=textchannel id=${channelId}\n`
        );
    });
}


// ------------------------------------------------------------
// ABRIR CHAT
// ------------------------------------------------------------

function openTsChat(chatId) {

    return new Promise((resolve, reject) => {

        if (tsChatSessions[chatId]) {
            closeTsChat(chatId);
        }

        const conn = new Client();

        const session = {

            conn,

            stream: null,

            panelId: null,

            messages: [],

            buffer: '',

            queryClientId: null

        };

        tsChatSessions[chatId] = session;


        conn.on('ready', () => {

            console.log(
                `[TS CHAT] SSH conectado para Telegram=${chatId}`
            );

            conn.shell((err, stream) => {

                if (err) {

                    closeTsChat(chatId);

                    return reject(err);
                }

                session.stream = stream;


                // ------------------------------------------------
                // LISTENER ÚNICO PARA TODA LA CONEXIÓN
                // ------------------------------------------------

                stream.on('data', data => {

                    session.buffer +=
                        data.toString();

                    const lines =
                        session.buffer.split(/\r?\n/);

                    session.buffer =
                        lines.pop() || '';

                    for (const rawLine of lines) {

                        const line =
                            rawLine.trim();

                        if (!line) continue;

                        console.log(
                            `[TS RAW] ${line}`
                        );

                        processTsNotification(
                            chatId,
                            line
                        );
                    }
                });


                stream.on('close', () => {

                    console.log(
                        `[TS CHAT] Stream cerrado Telegram=${chatId}`
                    );

                    if (
                        tsChatSessions[chatId]
                    ) {

                        delete tsChatSessions[
                            chatId
                        ];
                    }
                });


                stream.on('error', err => {

                    console.error(
                        '[TS CHAT] Stream error:',
                        err.message
                    );

                    closeTsChat(chatId);
                });


                // ------------------------------------------------
                // 1. SELECCIONAR SERVIDOR
                // ------------------------------------------------

                stream.write(
                    `use ${TS_SERVER_ID}\n`
                );


                // ------------------------------------------------
                // 2. ESPERAR UN POCO A QUE use TERMINE
                // ------------------------------------------------

                setTimeout(async () => {

                    try {

                        // ----------------------------------------
                        // 3. OBTENER CLID DEL SERVERQUERY
                        // ----------------------------------------

                        const clid =
                            await getQueryClientId(
                                stream
                            );

                        session.queryClientId =
                            clid;

                        console.log(
                            `[TS CHAT] ServerQuery clid=${clid}`
                        );


                        // ----------------------------------------
                        // 4. MOVER SERVERQUERY AL CANAL 1
                        // ----------------------------------------

                        await moveQueryToChannel(
                            stream,
                            clid,
                            TS_CHANNEL_ID
                        );

                        console.log(
                            `[TS CHAT] ServerQuery movido al canal ${TS_CHANNEL_ID}`
                        );


                        // ----------------------------------------
                        // 5. REGISTRAR TEXTCHANNEL
                        // ----------------------------------------

                        await registerTextChannel(
                            stream,
                            TS_CHANNEL_ID
                        );

                        console.log(
                            `[TS CHAT] Escuchando textchannel ${TS_CHANNEL_ID}`
                        );


                        // ----------------------------------------
                        // TODO CORRECTO
                        // ----------------------------------------

                        resolve();

                    } catch (e) {

                        console.error(
                            '[TS CHAT] Error inicializando:',
                            e.message
                        );

                        closeTsChat(chatId);

                        reject(e);
                    }

                }, 700);
            });
        });


        conn.on('error', err => {

            console.error(
                '[TS CHAT] SSH error:',
                err.message
            );

            closeTsChat(chatId);

            reject(err);
        });


        conn.connect({

            host: TS_HOST,

            port: TS_PORT,

            username: TS_USER,

            password: TS_PASS,

            readyTimeout: 7000,

            keepaliveInterval: 10000

        });
    });
}


// ------------------------------------------------------------
// ENVIAR MENSAJE TELEGRAM -> TEAMSPEAK
// ------------------------------------------------------------

function sendTsMessage(chatId, message) {

    return new Promise((resolve, reject) => {

        const session =
            tsChatSessions[chatId];

        if (
            !session ||
            !session.stream
        ) {

            return reject(
                new Error(
                    'Chat TeamSpeak cerrado'
                )
            );
        }


        const command =
            `sendtextmessage ` +
            `targetmode=2 ` +
            `target=${TS_CHANNEL_ID} ` +
            `msg=${tsEscape(message)}\n`;


        console.log(
            `[TS SEND] ${command.trim()}`
        );


        session.stream.write(
            command
        );


        resolve();
    });
}
```


// ============================================================
// PANEL PRINCIPAL
// ============================================================

async function sendMainMenu(chatId) {

    const role = authSessions[chatId]?.role;

    const keyboard = [
        [
            {
                text: '🖥️ Servidores',
                callback_data: 'menu_servers'
            },
            {
                text: '👥 TeamSpeak',
                callback_data: 'menu_ts'
            }
        ],
        [
            {
                text: '💬 Chat TeamSpeak',
                callback_data: 'menu_chat'
            },
            {
                text: '📊 Monitor',
                callback_data: 'menu_monitor'
            }
        ]
    ];

    if (role === 'admin') {
        keyboard.push([
            {
                text: '🔥 Top procesos',
                callback_data: 'sys_top'
            },
            {
                text: '🚀 Speedtest',
                callback_data: 'sys_speedtest'
            }
        ]);

        keyboard.push([
            {
                text: '🛰️ Reiniciar PC',
                callback_data: 'sys_reboot'
            },
            {
                text: '💀 Apagar PC',
                callback_data: 'sys_poweroff'
            }
        ]);
    }

    await bot.sendMessage(
        chatId,
        `🏠 *PANEL DE CONTROL*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 Acceso: *${role === 'admin' ? 'Administrador' : 'Invitado'}*\n\n` +
        `Selecciona una sección:`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: keyboard
            }
        }
    );
}

// ============================================================
// SERVIDORES
// ============================================================

async function showServers(chatId, editMessageId = null) {

    const servers = await getServers();

    let online = 0;

    for (const server of servers) {
        const state =
            server.attributes?.current_state ||
            server.attributes?.status ||
            'offline';

        if (
            state === 'running' ||
            state === 'online'
        ) {
            online++;
        }
    }

    let text =
        `🖥️ *SERVIDORES  ${online}/${servers.length}*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n`;

    const keyboard = [];

    for (const server of servers) {

        const a = server.attributes;
        const id = a.identifier;

        const running =
            a.current_state === 'running' ||
            a.status === 'running' ||
            a.current_state === 'online';

        const icon = running ? '🟢' : '🔴';

        text +=
            `${icon} *${a.name}*\n` +
            `${running ? 'ONLINE' : 'OFFLINE'}\n\n`;

        if (running) {

            keyboard.push([
                {
                    text: `🔄 ${a.name}`,
                    callback_data: `srv_restart_${id}`
                },
                {
                    text: `⏹️ ${a.name}`,
                    callback_data: `srv_stop_${id}`
                }
            ]);

        } else {

            keyboard.push([
                {
                    text: `▶️ Encender ${a.name}`,
                    callback_data: `srv_start_${id}`
                }
            ]);
        }
    }

    keyboard.push([
        {
            text: '🔄 Actualizar',
            callback_data: 'menu_servers'
        },
        {
            text: '◀️ Volver',
            callback_data: 'menu_home'
        }
    ]);

    const options = {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: keyboard
        }
    };

    if (editMessageId) {
        await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: editMessageId,
            ...options
        });
    } else {
        await bot.sendMessage(chatId, text, options);
    }
}

// ============================================================
// TEAMSPEAK USERS
// ============================================================

async function showTsUsers(chatId) {

    const users = await getTsUsers();

    let text =
        `👥 *TEAMSPEAK*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n`;

    if (!users.length) {
        text += `\n😴 No hay usuarios conectados.`;
    } else {

        text += `\n`;

        users.forEach((user, index) => {
            text +=
                `${index + 1}. 🟢 *${escapeMarkdown(user.client_nickname)}*\n`;
        });
    }

    await bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: '🔄 Actualizar',
                        callback_data: 'menu_ts'
                    },
                    {
                        text: '💬 Abrir chat',
                        callback_data: 'menu_chat'
                    }
                ],
                [
                    {
                        text: '◀️ Volver',
                        callback_data: 'menu_home'
                    }
                ]
            ]
        }
    });
}

// ============================================================
// MONITOR
// ============================================================

async function showMonitor(chatId) {

    const hw = await getHardwareStats();

    const cpu = Number(hw.cpu) || 0;
    const ram = Number(hw.ramP) || 0;
    const disk = Number(hw.diskP) || 0;

    const text =
        `📊 *HOST MONITOR*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +

        `🌡️ *CPU:* \`${hw.cpu}°C\`\n` +
        `${drawBar(cpu)}\n\n` +

        `🎮 *GPU:* \`${hw.gpu === 'N/D' ? 'N/D' : hw.gpu + '°C'}\`\n\n` +

        `📟 *RAM:* \`${hw.ramP}%\`\n` +
        `${drawBar(ram)}\n\n` +

        `💾 *DISCO:* \`${hw.diskP}%\`\n` +
        `${drawBar(disk)}\n\n` +

        `⏱️ *UPTIME:* \`${hw.up}\`\n` +
        `🌐 *PING:* \`${hw.ping} ms\`\n` +
        `⬇️ \`${hw.rx}\`   ⬆️ \`${hw.tx}\``;

    await bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: '🔄 Actualizar',
                        callback_data: 'menu_monitor'
                    }
                ],
                [
                    {
                        text: '◀️ Volver',
                        callback_data: 'menu_home'
                    }
                ]
            ]
        }
    });
}

// ============================================================
// /START
// ============================================================

bot.onText(/\/start|\/launch/, async (msg) => {

    const chatId = msg.chat.id;

    await limpiarHistorial(chatId, msg.message_id);

    if (!isAuthenticated(chatId)) {

        await bot.sendMessage(
            chatId,
            `🔐 *ACCESO AL PANEL*\n\n` +
            `Introduce la contraseña de invitado o administrador:`,
            {
                parse_mode: 'Markdown'
            }
        );

        return;
    }

    await sendMainMenu(chatId);
});

// ============================================================
// AUTENTICACIÓN Y MENSAJES DE TEXTO
// ============================================================

bot.on('message', async (msg) => {

    if (!msg.text) return;

    const chatId = msg.chat.id;
    const text = msg.text.trim();

    if (text.startsWith('/')) return;

    // ========================================================
    // AUTENTICACIÓN
    // ========================================================

    if (!isAuthenticated(chatId)) {

        if (text === ADMIN_PASSWORD) {

            authSessions[chatId] = {
                role: 'admin'
            };

            await bot.sendMessage(
                chatId,
                `🔓 *Acceso de administrador concedido.*`,
                {
                    parse_mode: 'Markdown'
                }
            );

            await sendMainMenu(chatId);

            return;
        }

        if (text === GUEST_PASSWORD) {

            authSessions[chatId] = {
                role: 'guest'
            };

            await bot.sendMessage(
                chatId,
                `🔓 *Acceso de invitado concedido.*`,
                {
                    parse_mode: 'Markdown'
                }
            );

            await sendMainMenu(chatId);

            return;
        }

        await bot.sendMessage(
            chatId,
            `❌ Contraseña incorrecta.`
        );

        return;
    }

    // ========================================================
    // CHAT TEAMSPEAK
    // ========================================================

    if (tsChatSessions[chatId]) {

        if (text.length > 300) {

            await bot.sendMessage(
                chatId,
                `⚠️ El mensaje es demasiado largo. Máximo 300 caracteres.`
            );

            return;
        }

        try {

            await sendTsMessage(chatId, text);

            const session = tsChatSessions[chatId];

            session.messages.push({
                name: 'Tú',
                text
            });

            if (session.messages.length > 20) {
                session.messages.shift();
            }

            updateChatPanel(chatId);

        } catch (e) {

            console.error(
                '[TS SEND ERROR]',
                e.message
            );

            await bot.sendMessage(
                chatId,
                `❌ No se pudo enviar el mensaje a TeamSpeak.`
            );
        }
    }
});

// ============================================================
// CALLBACKS
// ============================================================

bot.on('callback_query', async (query) => {

    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    await bot.answerCallbackQuery(query.id).catch(() => {});

    // ========================================================
    // MENÚ
    // ========================================================

    if (data === 'menu_home') {

        await sendMainMenu(chatId);
        return;
    }

    if (data === 'menu_servers') {

        try {
            await showServers(chatId, messageId);
        } catch (e) {
            await bot.sendMessage(
                chatId,
                `🔴 No se pudo consultar Pterodactyl.`
            );
        }

        return;
    }

    if (data === 'menu_ts') {

        try {
            await showTsUsers(chatId);
        } catch (e) {
            await bot.sendMessage(
                chatId,
                `🔴 No se pudo consultar TeamSpeak.`
            );
        }

        return;
    }

    if (data === 'menu_monitor') {

        try {
            await showMonitor(chatId);
        } catch (e) {
            await bot.sendMessage(
                chatId,
                `🔴 No se pudo obtener el monitor del host.`
            );
        }

        return;
    }

    // ========================================================
    // CHAT TEAMSPEAK
    // ========================================================

    if (data === 'menu_chat') {

        try {

            await bot.editMessageText(
                `💬 *Conectando al chat de TeamSpeak...*\n\n` +
                `⏳ Abriendo conexión en tiempo real...`,
                {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown'
                }
            );

            await openTsChat(chatId);

            tsChatSessions[chatId].panelId = messageId;

            updateChatPanel(chatId);

        } catch (e) {

            console.error('TS CHAT:', e);

            closeTsChat(chatId);

            await bot.editMessageText(
                `🔴 *No se pudo conectar al chat de TeamSpeak.*\n\n` +
                `Comprueba que el puerto ${TS_PORT} esté accesible desde Northflank.`,
                {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '◀️ Volver',
                                    callback_data: 'menu_home'
                                }
                            ]
                        ]
                    }
                }
            );
        }

        return;
    }

    if (data === 'ts_chat_close') {

        closeTsChat(chatId);

        await bot.editMessageText(
            `💬 *Chat TeamSpeak cerrado.*`,
            {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '💬 Volver a abrir',
                                callback_data: 'menu_chat'
                            }
                        ],
                        [
                            {
                                text: '◀️ Menú',
                                callback_data: 'menu_home'
                            }
                        ]
                    ]
                }
            }
        );

        return;
    }

    if (data === 'ts_chat_users') {

        const users = await getTsUsers();

        let usersText =
            `👥 *USUARIOS CONECTADOS*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n`;

        if (!users.length) {
            usersText += `😴 Nadie conectado.`;
        } else {
            usersText += users
                .map((u, i) =>
                    `${i + 1}. 🟢 ${escapeMarkdown(u.client_nickname)}`
                )
                .join('\n');
        }

        await bot.sendMessage(chatId, usersText, {
            parse_mode: 'Markdown'
        });

        return;
    }

    // ========================================================
    // ACCIONES DE SERVIDORES
    // ========================================================

    if (data.startsWith('srv_')) {

        if (!requireAdmin(chatId)) {

            await bot.sendMessage(
                chatId,
                `🔒 Esta acción requiere permisos de administrador.`
            );

            return;
        }

        const parts = data.split('_');

        const action = parts[1];
        const serverId = parts[2];

        if (action === 'stop' || action === 'restart') {

            const users = await getTsUsers();

            if (users.length > 0) {

                pendingActions[chatId] = {
                    type: 'server',
                    action,
                    serverId,
                    users
                };

                const names = users
                    .slice(0, 8)
                    .map(u => `• ${escapeMarkdown(u.client_nickname)}`)
                    .join('\n');

                await bot.sendMessage(
                    chatId,
                    `⚠️ *HAY USUARIOS CONECTADOS*\n\n` +
                    `TeamSpeak tiene actualmente *${users.length}* usuario(s):\n\n` +
                    `${names}\n\n` +
                    `¿Quieres continuar con la operación?`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    {
                                        text: '⚠️ Sí, continuar',
                                        callback_data: 'confirm_server'
                                    },
                                    {
                                        text: '❌ Cancelar',
                                        callback_data: 'cancel_action'
                                    }
                                ]
                            ]
                        }
                    }
                );

                return;
            }
        }

        try {

            const res = await powerServer(serverId, action);

            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }

            await bot.sendMessage(
                chatId,
                `✅ *${action.toUpperCase()}* enviado correctamente.`,
                {
                    parse_mode: 'Markdown'
                }
            );

        } catch (e) {

            await bot.sendMessage(
                chatId,
                `❌ Error al ejecutar la acción.`
            );
        }

        return;
    }

    // ========================================================
    // CONFIRMACIÓN DE SERVIDOR
    // ========================================================

    if (data === 'confirm_server') {

        if (!requireAdmin(chatId)) return;

        const pending = pendingActions[chatId];

        if (!pending) {

            await bot.sendMessage(
                chatId,
                `⚠️ La operación ya no está disponible.`
            );

            return;
        }

        delete pendingActions[chatId];

        try {

            const res = await powerServer(
                pending.serverId,
                pending.action
            );

            if (!res.ok) {
                throw new Error();
            }

            await bot.sendMessage(
                chatId,
                `✅ *${pending.action.toUpperCase()}* enviado.`,
                {
                    parse_mode: 'Markdown'
                }
            );

        } catch (e) {

            await bot.sendMessage(
                chatId,
                `❌ No se pudo ejecutar la operación.`
            );
        }

        return;
    }

    if (data === 'cancel_action') {

        delete pendingActions[chatId];

        await bot.sendMessage(
            chatId,
            `❌ Operación cancelada.`
        );

        return;
    }

    // ========================================================
    // TOP PROCESOS
    // ========================================================

    if (data === 'sys_top') {

        if (!requireAdmin(chatId)) return;

        const conn = new Client();

        conn.on('ready', () => {

            conn.exec(
                "ps -eo pcpu,comm --sort=-pcpu | head -n 6",
                (err, stream) => {

                    if (err) {
                        conn.end();
                        return;
                    }

                    let result = '';

                    stream
                        .on('data', d => result += d.toString())
                        .on('close', () => {

                            bot.sendMessage(
                                chatId,
                                `🔥 *TOP PROCESOS*\n\n` +
                                `\`\`\`\n${result}\`\`\``,
                                {
                                    parse_mode: 'Markdown'
                                }
                            );

                            conn.end();
                        });
                }
            );
        });

        conn.connect({
            host: sshHost,
            port: 2222,
            username: sshUser,
            password: sshPass
        });

        return;
    }

    // ========================================================
    // SPEEDTEST
    // ========================================================

    if (data === 'sys_speedtest') {

        if (!requireAdmin(chatId)) return;

        const testing = await bot.sendMessage(
            chatId,
            `🌐 Ejecutando Speedtest...\n⏳ Puede tardar unos segundos.`
        );

        const conn = new Client();

        conn.on('ready', () => {

            conn.exec(
                "speedtest-cli --simple",
                (err, stream) => {

                    if (err) {
                        conn.end();
                        return;
                    }

                    let result = '';

                    stream
                        .on('data', d => result += d.toString())
                        .on('close', () => {

                            bot.editMessageText(
                                `🚀 *SPEEDTEST*\n\n` +
                                `\`\`\`\n${result}\`\`\``,
                                {
                                    chat_id: chatId,
                                    message_id: testing.message_id,
                                    parse_mode: 'Markdown'
                                }
                            );

                            conn.end();
                        });
                }
            );
        });

        conn.connect({
            host: sshHost,
            port: 2222,
            username: sshUser,
            password: sshPass
        });

        return;
    }

    // ========================================================
    // REBOOT / POWEROFF
    // ========================================================

    if (
        data === 'sys_reboot' ||
        data === 'sys_poweroff'
    ) {

        if (!requireAdmin(chatId)) return;

        const action =
            data === 'sys_reboot'
                ? 'reboot'
                : 'poweroff';

        const users = await getTsUsers();

        if (users.length > 0) {

            pendingActions[chatId] = {
                type: 'system',
                action,
                users
            };

            const names = users
                .slice(0, 8)
                .map(u => `• ${escapeMarkdown(u.client_nickname)}`)
                .join('\n');

            await bot.sendMessage(
                chatId,
                `⚠️ *USUARIOS CONECTADOS A TEAMSPEAK*\n\n` +
                `${names}\n\n` +
                `Hay *${users.length}* usuario(s) conectado(s).\n\n` +
                `¿Seguro que quieres ${action === 'reboot' ? 'reiniciar' : 'apagar'} el PC?`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                {
                                    text: '⚠️ Continuar',
                                    callback_data: 'confirm_system'
                                },
                                {
                                    text: '❌ Cancelar',
                                    callback_data: 'cancel_action'
                                }
                            ]
                        ]
                    }
                }
            );

            return;
        }

        await executeSystemAction(chatId, action);

        return;
    }

    // ========================================================
    // CONFIRMAR SISTEMA
    // ========================================================

    if (data === 'confirm_system') {

        if (!requireAdmin(chatId)) return;

        const pending = pendingActions[chatId];

        if (!pending || pending.type !== 'system') {
            return;
        }

        delete pendingActions[chatId];

        await executeSystemAction(
            chatId,
            pending.action
        );

        return;
    }
});

// ============================================================
// EJECUTAR REBOOT / POWEROFF
// ============================================================

async function executeSystemAction(chatId, action) {

    await bot.sendMessage(
        chatId,
        `⚠️ Ejecutando *${action}*...`,
        {
            parse_mode: 'Markdown'
        }
    );

    const conn = new Client();

    conn.on('ready', () => {

        conn.exec(
            `sudo ${action}`,
            () => {
                setTimeout(() => {
                    conn.end();
                }, 1000);
            }
        );
    });

    conn.on('error', err => {
        console.error(
            'System action:',
            err.message
        );
    });

    conn.connect({
        host: sshHost,
        port: 2222,
        username: sshUser,
        password: sshPass
    });
}

// ============================================================
// AVISO DE ARRANQUE
// ============================================================

if (process.env.STARTUP_MESSAGE_CHAT_ID) {

    bot.sendMessage(
        process.env.STARTUP_MESSAGE_CHAT_ID,
        `✅ *SISTEMA ONLINE*\n` +
        `El bot de monitorización está operativo.`,
        {
            parse_mode: 'Markdown'
        }
    ).catch(() => {});
}

// ============================================================
// ERRORES
// ============================================================

bot.on('polling_error', error => {
    console.error(
        'Telegram polling:',
        error.message
    );
});

process.on('unhandledRejection', error => {
    console.error(
        'Unhandled rejection:',
        error
    );
});

console.log('🤖 Bot iniciado correctamente.');
