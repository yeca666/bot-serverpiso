const TelegramBot = require('node-telegram-bot-api');
const { Client } = require('ssh2');

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

// ============================================================
// TEAMSPEAK
// ============================================================

const TS_HOST =
    process.env.ts_query_host ||
    'serverpiso.duckdns.org';

const TS_PORT =
    Number(process.env.ts_query_port || 10022);

const TS_USER =
    process.env.ts_query_user ||
    'serveradmin';

const TS_PASS =
    process.env.ts_query_pass;

const TS_API_KEY =
    process.env.ts_api_key;

const TS_SERVER_ID =
    Number(process.env.ts_server_id || 1);

const TS_CHANNEL_ID =
    Number(process.env.ts_channel_id || 1);

// ============================================================
// BOT
// ============================================================

const bot = new TelegramBot(token, {
    polling: true
});

// ============================================================
// ESTADOS
// ============================================================

const authSessions = {};
const tsChatSessions = {};
const pendingActions = {};

// ============================================================
// UTILIDADES
// ============================================================

function escapeMarkdown(text) {
    return String(text)
        .replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

function drawBar(percentage, size = 10) {
    const pct = Math.max(
        0,
        Math.min(100, Number(percentage) || 0)
    );

    const filled = Math.round((pct / 100) * size);

    return (
        '▰'.repeat(filled) +
        '▱'.repeat(size - filled)
    );
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// QUITAR CÓDIGOS ANSI DE TEAMSPEAK
// ============================================================

function removeAnsi(text) {
    return String(text).replace(
        /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,
        ''
    );
}

// ============================================================
// DECODIFICAR TEAMSPEAK
// ============================================================

function decodeTs(value) {
    if (value === undefined || value === null) {
        return '';
    }

    const text = String(value);

    let result = '';

    for (let i = 0; i < text.length; i++) {

        if (text[i] !== '\\') {
            result += text[i];
            continue;
        }

        const next = text[i + 1];

        if (!next) {
            result += '\\';
            continue;
        }

        switch (next) {

            case 's':
                result += ' ';
                break;

            case 'p':
                result += '|';
                break;

            case 'n':
                result += '\n';
                break;

            case 'r':
                result += '\r';
                break;

            case '/':
                result += '/';
                break;

            case '\\':
                result += '\\';
                break;

            case 'a':
                result += '\x07';
                break;

            default:
                result += next;
                break;
        }

        i++;
    }

    return result;
}

// ============================================================
// ESCAPAR TEXTO PARA TEAMSPEAK
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

// ============================================================
// PARSER DE TEAMSPEAK QUERY
// ============================================================

function parseTsFields(line) {

    const fields = {};

    /*
     * TeamSpeak Query devuelve:
     *
     * targetmode=2 msg=hola\sdesde\steamspeak invokerid=10 ...
     *
     * NO devuelve los campos separados mediante "|".
     *
     * Este parser encuentra cada key=value respetando
     * los espacios escapados como \s.
     */

    const regex =
        /([a-zA-Z0-9_]+)=((?:\\.|[^\s])*)/g;

    let match;

    while ((match = regex.exec(line)) !== null) {

        const key = match[1];
        const value = match[2];

        fields[key] = decodeTs(value);
    }

    return fields;
}

// ============================================================
// LIMPIAR HISTORIAL TELEGRAM
// ============================================================

async function limpiarHistorial(chatId, lastMsgId) {

    for (let i = 0; i < 50; i++) {

        try {
            await bot.deleteMessage(
                chatId,
                lastMsgId - i
            );
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

    return new Promise(resolve => {

        const conn = new Client();

        conn.on('ready', () => {

            const command = `
if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits 2>/dev/null | head -n 1
else
    sensors 2>/dev/null | grep -Ei 'amdgpu|nouveau|radeon|GPU|edge|junction' | head -n 5
fi
`;

            conn.exec(command, (err, stream) => {

                if (err) {
                    conn.end();
                    return resolve('N/D');
                }

                let output = '';

                stream.on('data', data => {
                    output += data.toString();
                });

                stream.on('close', () => {

                    conn.end();

                    const nvidia =
                        output.match(
                            /^\s*(\d+(?:\.\d+)?)\s*$/m
                        );

                    if (nvidia) {
                        return resolve(nvidia[1]);
                    }

                    const generic =
                        output.match(
                            /\+?(\d+(?:\.\d+)?)°?C/i
                        );

                    if (generic) {
                        return resolve(generic[1]);
                    }

                    resolve('N/D');
                });
            });
        });

        conn.on('error', () => {
            resolve('N/D');
        });

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

            const command = `
sensors 2>/dev/null;
free -m;
uptime -p;
df -h /;
ping -c 1 -W 2 8.8.8.8;
ip -h -s link
`;

            conn.exec(command, (err, stream) => {

                if (err) {
                    conn.end();
                    return reject(err);
                }

                let output = '';

                stream
                    .on('data', data => {
                        output += data.toString();
                    })
                    .on('close', async () => {

                        const tempMatch =
                            output.match(
                                /Package id 0:\s+\+([\d.]+)/
                            );

                        const ramLine =
                            output.match(
                                /Mem:\s+(\d+)\s+(\d+)/
                            );

                        const uptimeMatch =
                            output.match(
                                /up\s+(.+)/
                            );

                        const diskLine =
                            output.match(
                                /\/dev\/.*?\s+(\d+\w)\s+(\d+\w)\s+(\d+\w)\s+(\d+)%/
                            );

                        const pingMatch =
                            output.match(
                                /time[=<]([\d.]+)\s*ms/
                            );

                        const netMatch =
                            output.match(
                                /RX:\s+bytes\s+packets.*?\s+([\d.]+\w).*?TX:\s+bytes\s+packets.*?\s+([\d.]+\w)/s
                            );

                        let ramPct = '0';

                        if (ramLine) {

                            const total =
                                parseInt(ramLine[1]);

                            const used =
                                parseInt(ramLine[2]);

                            if (total > 0) {

                                ramPct =
                                    ((used / total) * 100)
                                        .toFixed(1);
                            }
                        }

                        let upTime = 'N/D';

                        if (uptimeMatch) {

                            upTime =
                                uptimeMatch[1]
                                    .replace(/days?/g, 'd')
                                    .replace(/hours?/g, 'h')
                                    .replace(/minutes?/g, 'm')
                                    .replace(/seconds?/g, 's')
                                    .replace(/,/g, '');
                        }

                        const gpu =
                            await getGpuTemperature();

                        resolve({

                            cpu:
                                tempMatch
                                    ? tempMatch[1]
                                    : 'N/D',

                            gpu,

                            ramP:
                                ramPct,

                            up:
                                upTime,

                            diskP:
                                diskLine
                                    ? diskLine[4]
                                    : '0',

                            ping:
                                pingMatch
                                    ? pingMatch[1]
                                    : 'N/D',

                            rx:
                                netMatch
                                    ? netMatch[1]
                                    : 'N/D',

                            tx:
                                netMatch
                                    ? netMatch[2]
                                    : 'N/D'
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

    const res = await fetch(
        `${host}/api/client`,
        {
            headers: {
                Authorization:
                    `Bearer ${pteroKey}`,

                Accept:
                    'application/json'
            }
        }
    );

    if (!res.ok) {
        throw new Error(
            `Pterodactyl HTTP ${res.status}`
        );
    }

    const data =
        await res.json();

    return data.data || [];
}

async function powerServer(serverId, action) {

    return fetch(
        `${host}/api/client/servers/${serverId}/power`,
        {
            method: 'POST',

            headers: {
                Authorization:
                    `Bearer ${pteroKey}`,

                'Content-Type':
                    'application/json',

                Accept:
                    'application/json'
            },

            body: JSON.stringify({
                signal: action
            })
        }
    );
}

// ============================================================
// TEAMSPEAK HTTP QUERY
// ============================================================

async function tsRequest(path) {

    const url =
        `http://${TS_HOST}:10080/${TS_SERVER_ID}/${path}`;

    console.log('[TS HTTP]', url);

    const response =
        await fetch(
            url,
            {
                headers: {
                    'x-api-key':
                        TS_API_KEY,

                    Accept:
                        'application/json'
                }
            }
        );

    if (!response.ok) {

        throw new Error(
            `TeamSpeak HTTP ${response.status}`
        );
    }

    return response.json();
}

// ============================================================
// OBTENER USUARIOS DE TEAMSPEAK
// ============================================================

async function getTsUsers() {

    try {

        const result =
            await tsRequest('clientlist');

        console.log(
            '[TS USERS] Respuesta:',
            JSON.stringify(result)
        );

        if (
            !result ||
            !result.status ||
            Number(result.status.code) !== 0
        ) {

            console.error(
                '[TS USERS] Error:',
                JSON.stringify(result)
            );

            return [];
        }

        const clients =
            Array.isArray(result.body)
                ? result.body
                : [];

        console.log(
            '[TS USERS] Clientes encontrados:',
            clients.length
        );

        const users =
            clients.filter(client => {

                const type =
                    Number(client.client_type);

                const nickname =
                    String(
                        client.client_nickname || ''
                    );

                console.log(
                    '[TS USERS] Cliente:',
                    nickname,
                    'type:',
                    type
                );

                // 0 = usuario normal
                // 1 = ServerQuery
                return type === 0;
            });

        console.log(
            '[TS USERS] Usuarios normales:',
            users.map(
                u => u.client_nickname
            )
        );

        return users;

    } catch (e) {

        console.error(
            '[TS USERS] Error:',
            e.message
        );

        return [];
    }
}

// ============================================================
// TEAMSPEAK CHAT
// ============================================================

function closeTsChat(chatId) {

    const session =
        tsChatSessions[chatId];

    if (!session) {
        return;
    }

    try {

        if (session.stream) {

            session.stream.write(
                'servernotifyunregister event=textchannel\n'
            );
        }

    } catch (e) {}

    try {

        if (session.conn) {
            session.conn.end();
        }

    } catch (e) {}

    delete tsChatSessions[chatId];
}

// ============================================================
// ACTUALIZAR PANEL DEL CHAT
// ============================================================

function updateChatPanel(chatId) {

    const session = tsChatSessions[chatId];

    if (!session || !session.panelId) {
        return;
    }

    const lines =
        session.messages.length
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
        `👥 Pulsa "Usuarios conectados" para ver quién está en TeamSpeak.`;

    const keyboard = [
        [
            {
                text: '👥 Usuarios conectados',
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

    bot.editMessageText(
        text,
        {
            chat_id: chatId,
            message_id: session.panelId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: keyboard
            }
        }
    ).catch(error => {

        console.error(
            '[TELEGRAM PANEL]',
            error.message
        );
    });
}

// ============================================================
// ABRIR CHAT TEAMSPEAK
// ============================================================

function openTsChat(chatId) {

    return new Promise((resolve, reject) => {

        if (tsChatSessions[chatId]) {
            closeTsChat(chatId);
        }

        const conn =
            new Client();

        const session = {

            conn,

            stream:
                null,

            panelId:
                null,

            messages:
                [],

            buffer:
                ''
        };

        tsChatSessions[chatId] =
            session;

        conn.on('ready', () => {

            console.log(
                '[TS CHAT] SSH conectado'
            );

          conn.shell(
    false,
    (err, stream) => {

                    if (err) {

                        closeTsChat(chatId);

                        return reject(err);
                    }

                    session.stream =
                        stream;

                    console.log(
                        '[TS CHAT] Shell abierto'
                    );

                    // ====================================================
                    // RECEPCIÓN DE DATOS
                    // ====================================================

                    stream.on('data', data => {

                        let raw =
                            data.toString();

                        console.log(
                            '[TS RAW]',
                            JSON.stringify(raw)
                        );

                        // Eliminar ANSI.
                        raw =
                            removeAnsi(raw);

                        // Añadir al buffer.
                        session.buffer += raw;

                        /*
                         * TeamSpeak puede enviar una línea completa
                         * o partirla en varios paquetes.
                         *
                         * Ejemplo:
                         *
                         * paquete 1:
                         * notifytextmessage targetmode=2 msg=aa
                         *
                         * paquete 2:
                         * invokerid=10 invokername=Yeray_03
                         *
                         * Por eso NO procesamos cada data como
                         * si fuera una línea completa.
                         */

                        const lines =
                            session.buffer
                                .split(/\r?\n/);

                        // Guardar la última parte si está incompleta.
                        session.buffer =
                            lines.pop() || '';

                        for (
                            const rawLine of lines
                        ) {

                            const line =
                                rawLine.trim();

                            if (!line) {
                                continue;
                            }

                            console.log(
                                '[TS LINE]',
                                line
                            );

                            // ------------------------------------------------
                            // EVENTO DE MENSAJE
                            // ------------------------------------------------

                            if (
                                line.startsWith(
                                    'notifytextmessage'
                                )
                            ) {

                                const eventLine =
                                    line.replace(
                                        /^notifytextmessage\s*/,
                                        ''
                                    );

                                console.log(
                                    '[TS EVENT RAW]',
                                    eventLine
                                );

                                const fields =
                                    parseTsFields(
                                        eventLine
                                    );

                                console.log(
                                    '[TS EVENT PARSED]',
                                    JSON.stringify(fields)
                                );

                                const message =
                                    fields.msg || '';

                                const name =
                                    fields.invokername ||
                                    fields.invokeruid ||
                                    'Usuario';

                                if (!message) {

                                    console.log(
                                        '[TS EVENT] Mensaje vacío'
                                    );

                                    continue;
                                }

                                /*
                                 * Los mensajes que enviamos desde
                                 * Telegram los mostramos inmediatamente
                                 * como "Tú".
                                 *
                                 * TeamSpeak también genera un evento
                                 * notifytextmessage para ese mensaje.
                                 *
                                 * Lo ignoramos para evitar duplicarlo.
                                 */

                                if (
                                    fields.invokeruid === TS_USER ||
                                    fields.invokername === TS_USER
                                ) {

                                    console.log(
                                        '[TS EVENT] Ignorado: mensaje propio ya mostrado'
                                    );

                                    continue;
                                }

                                console.log(
                                    `[TS EVENT] ${name}: ${message}`
                                );

                                session.messages.push({

                                    name:
                                        name,

                                    text:
                                        message
                                });

                                if (
                                    session.messages.length > 20
                                ) {

                                    session.messages.shift();
                                }

                                updateChatPanel(
                                    chatId
                                );
                            }
                        }
                    });

                    // ====================================================
                    // CLOSE
                    // ====================================================

                    stream.on('close', () => {

                        console.log(
                            '[TS CHAT] Stream cerrado'
                        );

                        if (
                            tsChatSessions[chatId]
                        ) {

                            delete tsChatSessions[
                                chatId
                            ];
                        }
                    });

                    // ====================================================
                    // ERROR
                    // ====================================================

                    stream.on('error', error => {

                        console.error(
                            '[TS STREAM ERROR]',
                            error.message
                        );

                        closeTsChat(
                            chatId
                        );
                    });

                    // ====================================================
                    // SELECCIONAR SERVIDOR
                    // ====================================================

                    stream.write(
                        `use ${TS_SERVER_ID}\n`
                    );

                    console.log(
                        `[TS CHAT] Seleccionando servidor ${TS_SERVER_ID}`
                    );

                    // ====================================================
                    // SUSCRIBIRSE A MENSAJES DEL CANAL
                    // ====================================================

                    setTimeout(() => {

                        console.log(
                            `[TS CHAT] Suscribiendo a textchannel del canal ${TS_CHANNEL_ID}`
                        );

                        stream.write(
                            `servernotifyregister event=textchannel id=${TS_CHANNEL_ID}\n`
                        );

                        console.log(
                            '[TS CHAT] Suscripción enviada'
                        );

                    }, 800);

                    resolve();
                }
            );
        });

        conn.on('error', error => {

            console.error(
                '[TS SSH ERROR]',
                error.message
            );

            closeTsChat(chatId);

            reject(error);
        });

        conn.connect({

            host:
                TS_HOST,

            port:
                TS_PORT,

            username:
                TS_USER,

            password:
                TS_PASS,

            readyTimeout:
                7000,

            keepaliveInterval:
                10000
        });
    });
}

// ============================================================
// ENVIAR MENSAJE A TEAMSPEAK
// ============================================================

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

        const escaped =
            tsEscape(message);

        const command =
            `sendtextmessage targetmode=2 target=${TS_CHANNEL_ID} msg=${escaped}\n`;

        console.log(
            '[TS SEND]',
            command.trim()
        );

        try {

            session.stream.write(
                command
            );

            console.log(
                '[TS SEND] Comando enviado correctamente'
            );

            resolve();

        } catch (error) {

            console.error(
                '[TS SEND ERROR]',
                error.message
            );

            reject(error);
        }
    });
}

// ============================================================
// PANEL PRINCIPAL
// ============================================================

async function sendMainMenu(chatId) {

    const role =
        authSessions[chatId]?.role;

    const keyboard = [

        [
            {
                text: '🖥️ Servidores',
                callback_data:
                    'menu_servers'
            },

            {
                text: '👥 TeamSpeak',
                callback_data:
                    'menu_ts'
            }
        ],

        [
            {
                text: '💬 Chat TeamSpeak',
                callback_data:
                    'menu_chat'
            },

            {
                text: '📊 Monitor',
                callback_data:
                    'menu_monitor'
            }
        ]
    ];

    if (role === 'admin') {

        keyboard.push([

            {
                text: '🔥 Top procesos',
                callback_data:
                    'sys_top'
            },

            {
                text: '🚀 Speedtest',
                callback_data:
                    'sys_speedtest'
            }
        ]);

        keyboard.push([

            {
                text: '🛰️ Reiniciar PC',
                callback_data:
                    'sys_reboot'
            },

            {
                text: '💀 Apagar PC',
                callback_data:
                    'sys_poweroff'
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
            parse_mode:
                'Markdown',

            reply_markup: {
                inline_keyboard:
                    keyboard
            }
        }
    );
}

// ============================================================
// SERVIDORES
// ============================================================

async function showServers(
    chatId,
    editMessageId = null
) {

    const servers =
        await getServers();

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

        const a =
            server.attributes;

        const id =
            a.identifier;

        const running =
            a.current_state === 'running' ||
            a.status === 'running' ||
            a.current_state === 'online';

        const icon =
            running
                ? '🟢'
                : '🔴';

        text +=
            `${icon} *${escapeMarkdown(a.name)}*\n` +
            `${running ? 'ONLINE' : 'OFFLINE'}\n\n`;

        if (running) {

            keyboard.push([

                {
                    text:
                        `🔄 ${a.name}`,

                    callback_data:
                        `srv_restart_${id}`
                },

                {
                    text:
                        `⏹️ ${a.name}`,

                    callback_data:
                        `srv_stop_${id}`
                }
            ]);

        } else {

            keyboard.push([

                {
                    text:
                        `▶️ Encender ${a.name}`,

                    callback_data:
                        `srv_start_${id}`
                }
            ]);
        }
    }

    keyboard.push([

        {
            text:
                '🔄 Actualizar',

            callback_data:
                'menu_servers'
        },

        {
            text:
                '◀️ Volver',

            callback_data:
                'menu_home'
        }
    ]);

    const options = {

        parse_mode:
            'Markdown',

        reply_markup: {
            inline_keyboard:
                keyboard
        }
    };

    if (editMessageId) {

        await bot.editMessageText(
            text,
            {
                chat_id:
                    chatId,

                message_id:
                    editMessageId,

                ...options
            }
        );

    } else {

        await bot.sendMessage(
            chatId,
            text,
            options
        );
    }
}

// ============================================================
// USUARIOS TEAMSPEAK
// ============================================================

async function showTsUsers(chatId) {

    const users =
        await getTsUsers();

    let text =
        `👥 *TEAMSPEAK*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n`;

    if (!users.length) {

        text +=
            `\n😴 No hay usuarios conectados.`;

    } else {

        text += '\n';

        users.forEach(
            (user, index) => {

                text +=
                    `${index + 1}. 🟢 *${escapeMarkdown(user.client_nickname)}*\n`;
            }
        );
    }

    await bot.sendMessage(

        chatId,

        text,

        {
            parse_mode:
                'Markdown',

            reply_markup: {

                inline_keyboard: [

                    [

                        {
                            text:
                                '🔄 Actualizar',

                            callback_data:
                                'menu_ts'
                        },

                        {
                            text:
                                '💬 Abrir chat',

                            callback_data:
                                'menu_chat'
                        }
                    ],

                    [

                        {
                            text:
                                '◀️ Volver',

                            callback_data:
                                'menu_home'
                        }
                    ]
                ]
            }
        }
    );
}

// ============================================================
// MONITOR
// ============================================================

async function showMonitor(chatId) {

    const hw =
        await getHardwareStats();

    const cpu =
        Number(hw.cpu) || 0;

    const ram =
        Number(hw.ramP) || 0;

    const disk =
        Number(hw.diskP) || 0;

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

    await bot.sendMessage(

        chatId,

        text,

        {
            parse_mode:
                'Markdown',

            reply_markup: {

                inline_keyboard: [

                    [

                        {
                            text:
                                '🔄 Actualizar',

                            callback_data:
                                'menu_monitor'
                        }
                    ],

                    [

                        {
                            text:
                                '◀️ Volver',

                            callback_data:
                                'menu_home'
                        }
                    ]
                ]
            }
        }
    );
}

// ============================================================
// /START
// ============================================================

bot.onText(
    /\/start|\/launch/,
    async msg => {

        const chatId =
            msg.chat.id;

        await limpiarHistorial(
            chatId,
            msg.message_id
        );

        if (!isAuthenticated(chatId)) {

            await bot.sendMessage(

                chatId,

                `🔐 *ACCESO AL PANEL*\n\n` +
                `Introduce la contraseña de invitado o administrador:`,

                {
                    parse_mode:
                        'Markdown'
                }
            );

            return;
        }

        await sendMainMenu(chatId);
    }
);

// ============================================================
// MENSAJES DE TELEGRAM
// ============================================================

bot.on(
    'message',
    async msg => {

        if (!msg.text) {
            return;
        }

        const chatId =
            msg.chat.id;

        const text =
            msg.text.trim();

        // No procesar comandos.
        if (text.startsWith('/')) {
            return;
        }

        // ====================================================
        // AUTENTICACIÓN
        // ====================================================

        if (!isAuthenticated(chatId)) {

            if (text === ADMIN_PASSWORD) {

                authSessions[chatId] = {
                    role: 'admin'
                };

                await bot.sendMessage(
                    chatId,
                    `🔓 *Acceso de administrador concedido.*`,
                    {
                        parse_mode:
                            'Markdown'
                    }
                );

                await sendMainMenu(
                    chatId
                );

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
                        parse_mode:
                            'Markdown'
                    }
                );

                await sendMainMenu(
                    chatId
                );

                return;
            }

            await bot.sendMessage(
                chatId,
                `❌ Contraseña incorrecta.`
            );

            return;
        }

        // ====================================================
        // CHAT TEAMSPEAK
        // ====================================================

        if (tsChatSessions[chatId]) {

            if (text.length > 300) {

                await bot.sendMessage(
                    chatId,
                    `⚠️ El mensaje es demasiado largo. Máximo 300 caracteres.`
                );

                return;
            }

            try {

                await sendTsMessage(
                    chatId,
                    text
                );

                // Mostrar inmediatamente nuestro propio mensaje.
                const session =
                    tsChatSessions[chatId];

                session.messages.push({

                    name:
                        'Tú',

                    text:
                        text
                });

                if (
                    session.messages.length > 20
                ) {

                    session.messages.shift();
                }

                updateChatPanel(
                    chatId
                );

            } catch (e) {

                console.error(
                    '[TELEGRAM -> TS]',
                    e.message
                );

                await bot.sendMessage(
                    chatId,
                    `❌ No se pudo enviar el mensaje a TeamSpeak.`
                );
            }
        }
    }
);

// ============================================================
// CALLBACKS
// ============================================================

bot.on(
    'callback_query',
    async query => {

        const data =
            query.data;

        const chatId =
            query.message.chat.id;

        const messageId =
            query.message.message_id;

        await bot.answerCallbackQuery(
            query.id
        ).catch(() => {});

        // ====================================================
        // MENÚ
        // ====================================================

        if (data === 'menu_home') {

            await sendMainMenu(
                chatId
            );

            return;
        }

        if (data === 'menu_servers') {

            try {

                await showServers(
                    chatId,
                    messageId
                );

            } catch (e) {

                console.error(
                    'Pterodactyl:',
                    e.message
                );

                await bot.sendMessage(
                    chatId,
                    `🔴 No se pudo consultar Pterodactyl.`
                );
            }

            return;
        }

        if (data === 'menu_ts') {

            try {

                await showTsUsers(
                    chatId
                );

            } catch (e) {

                console.error(
                    'TeamSpeak users:',
                    e.message
                );

                await bot.sendMessage(
                    chatId,
                    `🔴 No se pudo consultar TeamSpeak.`
                );
            }

            return;
        }

        if (data === 'menu_monitor') {

            try {

                await showMonitor(
                    chatId
                );

            } catch (e) {

                console.error(
                    'Monitor:',
                    e.message
                );

                await bot.sendMessage(
                    chatId,
                    `🔴 No se pudo obtener el monitor del host.`
                );
            }

            return;
        }

        // ====================================================
        // ABRIR CHAT TEAMSPEAK
        // ====================================================

        if (data === 'menu_chat') {

            try {

                await bot.editMessageText(

                    `💬 *Conectando al chat de TeamSpeak...*\n\n` +
                    `⏳ Abriendo conexión en tiempo real...`,

                    {
                        chat_id:
                            chatId,

                        message_id:
                            messageId,

                        parse_mode:
                            'Markdown'
                    }
                );

                await openTsChat(
                    chatId
                );

                tsChatSessions[
                    chatId
                ].panelId =
                    messageId;

                updateChatPanel(
                    chatId
                );

            } catch (e) {

                console.error(
                    'TS CHAT:',
                    e
                );

                closeTsChat(
                    chatId
                );

                await bot.editMessageText(

                    `🔴 *No se pudo conectar al chat de TeamSpeak.*\n\n` +
                    `Comprueba que el puerto ${TS_PORT} esté accesible desde Northflank.`,

                    {
                        chat_id:
                            chatId,

                        message_id:
                            messageId,

                        parse_mode:
                            'Markdown',

                        reply_markup: {

                            inline_keyboard: [

                                [

                                    {
                                        text:
                                            '◀️ Volver',

                                        callback_data:
                                            'menu_home'
                                    }
                                ]
                            ]
                        }
                    }
                );
            }

            return;
        }

        // ====================================================
        // CERRAR CHAT
        // ====================================================

        if (data === 'ts_chat_close') {

            closeTsChat(
                chatId
            );

            await bot.editMessageText(

                `💬 *Chat TeamSpeak cerrado.*`,

                {
                    chat_id:
                        chatId,

                    message_id:
                        messageId,

                    parse_mode:
                        'Markdown',

                    reply_markup: {

                        inline_keyboard: [

                            [

                                {
                                    text:
                                        '💬 Volver a abrir',

                                    callback_data:
                                        'menu_chat'
                                }
                            ],

                            [

                                {
                                    text:
                                        '◀️ Menú',

                                    callback_data:
                                        'menu_home'
                                }
                            ]
                        ]
                    }
                }
            );

            return;
        }

        // ====================================================
        // USUARIOS DESDE CHAT
        // ====================================================

        if (data === 'ts_chat_users') {

            const users =
                await getTsUsers();

            let usersText =
                `👥 *USUARIOS CONECTADOS*\n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n`;

            if (!users.length) {

                usersText +=
                    `😴 Nadie conectado.`;

            } else {

                usersText +=
                    users
                        .map(
                            (u, i) =>
                                `${i + 1}. 🟢 ${escapeMarkdown(u.client_nickname)}`
                        )
                        .join('\n');
            }

            await bot.sendMessage(
                chatId,
                usersText,
                {
                    parse_mode:
                        'Markdown'
                }
            );

            return;
        }

        // ====================================================
        // ACCIONES SERVIDORES
        // ====================================================

        if (data.startsWith('srv_')) {

            if (!requireAdmin(chatId)) {

                await bot.sendMessage(
                    chatId,
                    `🔒 Esta acción requiere permisos de administrador.`
                );

                return;
            }

            const parts =
                data.split('_');

            const action =
                parts[1];

            const serverId =
                parts[2];

            if (
                action === 'stop' ||
                action === 'restart'
            ) {

                const users =
                    await getTsUsers();

                if (users.length > 0) {

                    pendingActions[
                        chatId
                    ] = {

                        type:
                            'server',

                        action,

                        serverId,

                        users
                    };

                    const names =
                        users
                            .slice(0, 8)
                            .map(
                                u =>
                                    `• ${escapeMarkdown(u.client_nickname)}`
                            )
                            .join('\n');

                    await bot.sendMessage(

                        chatId,

                        `⚠️ *HAY USUARIOS CONECTADOS*\n\n` +
                        `TeamSpeak tiene actualmente *${users.length}* usuario(s):\n\n` +
                        `${names}\n\n` +
                        `¿Quieres continuar con la operación?`,

                        {
                            parse_mode:
                                'Markdown',

                            reply_markup: {

                                inline_keyboard: [

                                    [

                                        {
                                            text:
                                                '⚠️ Sí, continuar',

                                            callback_data:
                                                'confirm_server'
                                        },

                                        {
                                            text:
                                                '❌ Cancelar',

                                            callback_data:
                                                'cancel_action'
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

                const res =
                    await powerServer(
                        serverId,
                        action
                    );

                if (!res.ok) {

                    throw new Error(
                        `HTTP ${res.status}`
                    );
                }

                await bot.sendMessage(

                    chatId,

                    `✅ *${action.toUpperCase()}* enviado correctamente.`,

                    {
                        parse_mode:
                            'Markdown'
                    }
                );

            } catch (e) {

                console.error(
                    'Server action:',
                    e.message
                );

                await bot.sendMessage(
                    chatId,
                    `❌ Error al ejecutar la acción.`
                );
            }

            return;
        }

        // ====================================================
        // CONFIRMAR SERVIDOR
        // ====================================================

        if (data === 'confirm_server') {

            if (!requireAdmin(chatId)) {
                return;
            }

            const pending =
                pendingActions[chatId];

            if (!pending) {

                await bot.sendMessage(
                    chatId,
                    `⚠️ La operación ya no está disponible.`
                );

                return;
            }

            delete pendingActions[
                chatId
            ];

            try {

                const res =
                    await powerServer(
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
                        parse_mode:
                            'Markdown'
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

        // ====================================================
        // CANCELAR
        // ====================================================

        if (data === 'cancel_action') {

            delete pendingActions[
                chatId
            ];

            await bot.sendMessage(
                chatId,
                `❌ Operación cancelada.`
            );

            return;
        }

        // ====================================================
        // TOP PROCESOS
        // ====================================================

        if (data === 'sys_top') {

            if (!requireAdmin(chatId)) {
                return;
            }

            const conn =
                new Client();

            conn.on('ready', () => {

                conn.exec(
                    'ps -eo pcpu,comm --sort=-pcpu | head -n 6',
                    (err, stream) => {

                        if (err) {

                            conn.end();

                            return;
                        }

                        let result =
                            '';

                        stream
                            .on(
                                'data',
                                d =>
                                    result += d.toString()
                            )
                            .on(
                                'close',
                                () => {

                                    bot.sendMessage(

                                        chatId,

                                        `🔥 *TOP PROCESOS*\n\n` +
                                        `\`\`\`\n${result}\`\`\``,

                                        {
                                            parse_mode:
                                                'Markdown'
                                        }
                                    );

                                    conn.end();
                                }
                            );
                    }
                );
            });

            conn.connect({

                host:
                    sshHost,

                port:
                    2222,

                username:
                    sshUser,

                password:
                    sshPass
            });

            return;
        }

        // ====================================================
        // SPEEDTEST
        // ====================================================

        if (data === 'sys_speedtest') {

            if (!requireAdmin(chatId)) {
                return;
            }

            const testing =
                await bot.sendMessage(

                    chatId,

                    `🌐 Ejecutando Speedtest...\n⏳ Puede tardar unos segundos.`
                );

            const conn =
                new Client();

            conn.on('ready', () => {

                conn.exec(
                    'speedtest-cli --simple',
                    (err, stream) => {

                        if (err) {

                            conn.end();

                            return;
                        }

                        let result =
                            '';

                        stream
                            .on(
                                'data',
                                d =>
                                    result += d.toString()
                            )
                            .on(
                                'close',
                                () => {

                                    bot.editMessageText(

                                        `🚀 *SPEEDTEST*\n\n` +
                                        `\`\`\`\n${result}\`\`\``,

                                        {
                                            chat_id:
                                                chatId,

                                            message_id:
                                                testing.message_id,

                                            parse_mode:
                                                'Markdown'
                                        }
                                    );

                                    conn.end();
                                }
                            );
                    }
                );
            });

            conn.connect({

                host:
                    sshHost,

                port:
                    2222,

                username:
                    sshUser,

                password:
                    sshPass
            });

            return;
        }

        // ====================================================
        // REBOOT / POWEROFF
        // ====================================================

        if (
            data === 'sys_reboot' ||
            data === 'sys_poweroff'
        ) {

            if (!requireAdmin(chatId)) {
                return;
            }

            const action =
                data === 'sys_reboot'
                    ? 'reboot'
                    : 'poweroff';

            const users =
                await getTsUsers();

            if (users.length > 0) {

                pendingActions[
                    chatId
                ] = {

                    type:
                        'system',

                    action,

                    users
                };

                const names =
                    users
                        .slice(0, 8)
                        .map(
                            u =>
                                `• ${escapeMarkdown(u.client_nickname)}`
                        )
                        .join('\n');

                await bot.sendMessage(

                    chatId,

                    `⚠️ *USUARIOS CONECTADOS A TEAMSPEAK*\n\n` +
                    `${names}\n\n` +
                    `Hay *${users.length}* usuario(s) conectado(s).\n\n` +
                    `¿Seguro que quieres ${action === 'reboot' ? 'reiniciar' : 'apagar'} el PC?`,

                    {
                        parse_mode:
                            'Markdown',

                        reply_markup: {

                            inline_keyboard: [

                                [

                                    {
                                        text:
                                            '⚠️ Continuar',

                                        callback_data:
                                            'confirm_system'
                                    },

                                    {
                                        text:
                                            '❌ Cancelar',

                                        callback_data:
                                            'cancel_action'
                                    }
                                ]
                            ]
                        }
                    }
                );

                return;
            }

            await executeSystemAction(
                chatId,
                action
            );

            return;
        }

        // ====================================================
        // CONFIRMAR SISTEMA
        // ====================================================

        if (data === 'confirm_system') {

            if (!requireAdmin(chatId)) {
                return;
            }

            const pending =
                pendingActions[chatId];

            if (
                !pending ||
                pending.type !== 'system'
            ) {
                return;
            }

            delete pendingActions[
                chatId
            ];

            await executeSystemAction(
                chatId,
                pending.action
            );

            return;
        }
    }
);

// ============================================================
// EJECUTAR REBOOT / POWEROFF
// ============================================================

async function executeSystemAction(
    chatId,
    action
) {

    await bot.sendMessage(

        chatId,

        `⚠️ Ejecutando *${action}*...`,

        {
            parse_mode:
                'Markdown'
        }
    );

    const conn =
        new Client();

    conn.on('ready', () => {

        conn.exec(
            `sudo ${action}`,
            () => {

                setTimeout(
                    () => {
                        conn.end();
                    },
                    1000
                );
            }
        );
    });

    conn.on('error', error => {

        console.error(
            'System action:',
            error.message
        );
    });

    conn.connect({

        host:
            sshHost,

        port:
            2222,

        username:
            sshUser,

        password:
            sshPass
    });
}

// ============================================================
// AVISO DE ARRANQUE
// ============================================================

if (
    process.env.STARTUP_MESSAGE_CHAT_ID
) {

    bot.sendMessage(

        process.env.STARTUP_MESSAGE_CHAT_ID,

        `✅ *SISTEMA ONLINE*\n` +
        `El bot de monitorización está operativo.`,

        {
            parse_mode:
                'Markdown'
        }
    ).catch(() => {});
}

// ============================================================
// ERRORES
// ============================================================

bot.on(
    'polling_error',
    error => {

        console.error(
            'Telegram polling:',
            error.message
        );
    }
);

process.on(
    'unhandledRejection',
    error => {

        console.error(
            'Unhandled rejection:',
            error
        );
    }
);

process.on(
    'uncaughtException',
    error => {

        console.error(
            'Uncaught exception:',
            error
        );
    }
);

console.log(
    '🤖 Bot iniciado correctamente.'
);
