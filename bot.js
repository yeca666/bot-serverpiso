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
const sshHost =
    process.env.ssh_host || 'serverpiso.duckdns.org';

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
// ESTADO
// ============================================================

const authSessions = {};
const tsChatSessions = {};
const pendingActions = {};

// ============================================================
// UTILIDADES TELEGRAM
// ============================================================

function escapeTelegramHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeMarkdown(text) {
    return String(text ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/_/g, '\\_')
        .replace(/\*/g, '\\*')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)')
        .replace(/~/g, '\\~')
        .replace(/>/g, '\\>')
        .replace(/#/g, '\\#')
        .replace(/\+/g, '\\+')
        .replace(/-/g, '\\-')
        .replace(/=/g, '\\=')
        .replace(/\|/g, '\\|')
        .replace(/{/g, '\\{')
        .replace(/}/g, '\\}')
        .replace(/\./g, '\\.')
        .replace(/!/g, '\\!');
}

function drawBar(value, size = 10) {
    const pct = Math.max(
        0,
        Math.min(100, Number(value) || 0)
    );

    const filled = Math.round(
        (pct / 100) * size
    );

    return (
        '▰'.repeat(filled) +
        '▱'.repeat(size - filled)
    );
}

// ============================================================
// ANSI / TEAMSPEAK
// ============================================================

function removeAnsi(text) {
    return String(text).replace(
        /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,
        ''
    );
}

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

function tsEscape(text) {
    return String(text)
        .replace(/\\/g, '\\\\')
        .replace(/\|/g, '\\p')
        .replace(/\//g, '\\/')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/ /g, '\\s');
}

function parseTsFields(line) {
    const fields = {};

    const regex =
        /([a-zA-Z0-9_]+)=((?:\\.|[^\s])*)/g;

    let match;

    while ((match = regex.exec(line)) !== null) {
        fields[match[1]] = decodeTs(match[2]);
    }

    return fields;
}

// ============================================================
// HISTORIAL
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

function requireAdmin(chatId) {
    return isAdmin(chatId);
}

// ============================================================
// SSH HOST
// ============================================================

function sshExec(command, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const conn = new Client();

        let settled = false;

        const finishResolve = value => {
            if (settled) return;

            settled = true;

            try {
                conn.end();
            } catch (e) {}

            resolve(value);
        };

        const finishReject = error => {
            if (settled) return;

            settled = true;

            try {
                conn.end();
            } catch (e) {}

            reject(error);
        };

        const timer = setTimeout(() => {
            finishReject(
                new Error('SSH timeout')
            );
        }, timeout);

        conn.on('ready', () => {
            conn.exec(
                command,
                (err, stream) => {
                    if (err) {
                        clearTimeout(timer);
                        finishReject(err);
                        return;
                    }

                    let stdout = '';
                    let stderr = '';

                    stream.on('data', data => {
                        stdout += data.toString();
                    });

                    stream.stderr.on('data', data => {
                        stderr += data.toString();
                    });

                    stream.on('close', () => {
                        clearTimeout(timer);

                        finishResolve({
                            stdout,
                            stderr
                        });
                    });
                }
            );
        });

        conn.on('error', error => {
            clearTimeout(timer);
            finishReject(error);
        });

        conn.connect({
            host: sshHost,
            port: 2222,
            username: sshUser,
            password: sshPass,
            readyTimeout: 7000
        });
    });
}

// ============================================================
// MONITOR
// ============================================================

async function getHardwareStats() {
    try {
        const command = `
echo "__SENSORS__"
sensors 2>/dev/null

echo "__GPU__"
nvidia-smi --query-gpu=temperature.gpu,gpu_util --format=csv,noheader,nounits 2>/dev/null | head -n 1

echo "__RAM__"
free -m

echo "__PING__"
ping -c 1 -W 2 1.1.1.1 2>/dev/null

echo "__UPTIME__"
uptime -p

echo "__DISK__"
df -h /

echo "__END__"
`;

        const result = await sshExec(
            command,
            12000
        );

        const output = result.stdout || '';

        // ------------------------------------------------------
        // CPU
        // ------------------------------------------------------

        let cpu = 'N/D';

        const cpuPatterns = [
            /Package id 0:\s+\+?([\d.]+)\s*°?C/i,
            /Tctl:\s+\+?([\d.]+)\s*°?C/i,
            /CPU(?: Temperature| Temp)?[^+\d]*\+?([\d.]+)\s*°?C/i,
            /temp1:\s+\+?([\d.]+)\s*°?C/i
        ];

        for (const pattern of cpuPatterns) {
            const match = output.match(pattern);

            if (match) {
                cpu = Number(match[1]).toFixed(1);
                break;
            }
        }

        // ------------------------------------------------------
        // GPU
        // ------------------------------------------------------

        let gpu = 'N/D';
        let gpuUtil = 'N/D';

        const gpuMatch = output.match(
            /__GPU__\s*[\r\n]+([0-9.]+)\s*,\s*([0-9.]+)/m
        );

        if (gpuMatch) {
            gpu = Number(gpuMatch[1]).toFixed(1);
            gpuUtil = Number(gpuMatch[2]).toFixed(1);
        }

        // ------------------------------------------------------
        // RAM
        // ------------------------------------------------------

        let ramP = 'N/D';

        const ramMatch = output.match(
            /__RAM__[\s\S]*?Mem:\s+(\d+)\s+(\d+)/m
        );

        if (ramMatch) {
            const total = Number(ramMatch[1]);
            const used = Number(ramMatch[2]);

            if (total > 0) {
                ramP = (
                    (used / total) * 100
                ).toFixed(1);
            }
        }

        // ------------------------------------------------------
        // PING
        // ------------------------------------------------------

        let ping = 'N/D';

        const pingMatch = output.match(
            /__PING__[\s\S]*?time[=<]([\d.]+)\s*ms/i
        );

        if (pingMatch) {
            ping = Number(
                pingMatch[1]
            ).toFixed(1);
        }

        // ------------------------------------------------------
        // UPTIME
        // ------------------------------------------------------

        let uptime = 'N/D';

        const uptimeMatch = output.match(
            /__UPTIME__\s*[\r\n]+([^\r\n]+)/m
        );

        if (uptimeMatch) {
            uptime = uptimeMatch[1]
                .trim()
                .replace(/days?/g, 'd')
                .replace(/hours?/g, 'h')
                .replace(/minutes?/g, 'm')
                .replace(/seconds?/g, 's')
                .replace(/,/g, '');
        }

        // ------------------------------------------------------
        // DISCO
        // ------------------------------------------------------

        let diskP = 'N/D';

        const diskMatch = output.match(
            /__DISK__[\s\S]*?\s(\d+)%\s+\/\s*$/m
        );

        if (diskMatch) {
            diskP = Number(diskMatch[1]);
        }

        return {
            cpu,
            gpu,
            gpuUtil,
            ramP,
            ping,
            uptime,
            diskP
        };

    } catch (error) {
        console.error(
            '[HOST MONITOR]',
            error.message
        );

        return {
            cpu: 'N/D',
            gpu: 'N/D',
            gpuUtil: 'N/D',
            ramP: 'N/D',
            ping: 'N/D',
            uptime: 'N/D',
            diskP: 'N/D'
        };
    }
}

// ============================================================
// PTERODACTYL
// ============================================================

async function getServers() {
    const response = await fetch(
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

    if (!response.ok) {
        throw new Error(
            `Pterodactyl HTTP ${response.status}`
        );
    }

    const data =
        await response.json();

    const servers = data.data || [];

    for (const server of servers) {
        try {
            const identifier =
                server.attributes.identifier;

            const resourceResponse =
                await fetch(
                    `${host}/api/client/servers/${identifier}/resources`,
                    {
                        headers: {
                            Authorization:
                                `Bearer ${pteroKey}`,
                            Accept:
                                'application/json'
                        }
                    }
                );

            if (resourceResponse.ok) {
                const resourceData =
                    await resourceResponse.json();

                server.attributes.current_state =
                    resourceData.attributes?.current_state ||
                    'offline';

                server.attributes.resources =
                    resourceData.attributes?.resources ||
                    {};
            } else {
                server.attributes.current_state =
                    'unknown';
            }

        } catch (error) {
            console.error(
                '[PTERODACTYL STATE]',
                server.attributes?.identifier,
                error.message
            );

            server.attributes.current_state =
                'unknown';
        }
    }

    return servers;
}

async function powerServer(
    serverId,
    action
) {
    return fetch(
        `${host}/api/client/servers/${serverId}/power`,
        {
            method:
                'POST',

            headers: {
                Authorization:
                    `Bearer ${pteroKey}`,

                'Content-Type':
                    'application/json',

                Accept:
                    'application/json'
            },

            body:
                JSON.stringify({
                    signal:
                        action
                })
        }
    );
}

// ============================================================
// SERVERQUERY
// ============================================================

function createTsQuerySession() {
    return new Promise((resolve, reject) => {
        const conn = new Client();

        conn.on('ready', () => {
            conn.shell(
                false,
                (err, stream) => {
                    if (err) {
                        conn.end();
                        reject(err);
                        return;
                    }

                    resolve({
                        conn,
                        stream
                    });
                }
            );
        });

        conn.on('error', reject);

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
// PARSEAR CLIENTLIST
// ============================================================

function parseClientList(output) {
    const clients = [];

    const lines = output
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    for (const line of lines) {
        if (
            !line.includes('client_type=')
        ) {
            continue;
        }

        const fields =
            parseTsFields(line);

        const type =
            Number(fields.client_type);

        if (type !== 0) {
            continue;
        }

        clients.push({
            nickname:
                fields.client_nickname ||
                'Usuario',
            clid:
                fields.clid || '',
            cid:
                fields.cid || '',
            databaseId:
                fields.client_database_id ||
                ''
        });
    }

    return clients;
}

// ============================================================
// CLIENTLIST MEDIANTE UNA SESIÓN EXISTENTE
// ============================================================

function getTsUsersFromSession(session) {
    return new Promise((resolve, reject) => {
        if (
            !session ||
            !session.stream
        ) {
            reject(
                new Error(
                    'No existe sesión TeamSpeak'
                )
            );
            return;
        }

        let buffer = '';
        let finished = false;

        const onData = data => {
            buffer += removeAnsi(
                data.toString()
            );

            const lines =
                buffer.split(/\r?\n/);

            buffer =
                lines.pop() || '';

            for (const rawLine of lines) {
                const line =
                    rawLine.trim();

                if (!line) {
                    continue;
                }

                if (
                    line.startsWith('clid=') ||
                    line.includes(
                        'client_nickname='
                    )
                ) {
                    session.userQueryBuffer =
                        session.userQueryBuffer || [];

                    session.userQueryBuffer.push(
                        line
                    );
                }

                if (
                    line.startsWith('error id=')
                ) {
                    const fields =
                        parseTsFields(
                            line.replace(
                                /^error\s+/,
                                ''
                            )
                        );

                    const code =
                        Number(fields.id || 0);

                    if (
                        code === 0
                    ) {
                        finished = true;

                        session.stream.removeListener(
                            'data',
                            onData
                        );

                        const text =
                            (
                                session.userQueryBuffer ||
                                []
                            ).join('\n');

                        session.userQueryBuffer =
                            [];

                        resolve(
                            parseClientList(
                                text
                            )
                        );
                    } else {
                        finished = true;

                        session.stream.removeListener(
                            'data',
                            onData
                        );

                        session.userQueryBuffer =
                            [];

                        reject(
                            new Error(line)
                        );
                    }
                }
            }
        };

        session.stream.on(
            'data',
            onData
        );

        session.userQueryBuffer = [];

        try {
            session.stream.write(
                `use ${TS_SERVER_ID}\n`
            );

            setTimeout(() => {
                if (!finished) {
                    session.stream.write(
                        'clientlist -uid\n'
                    );
                }
            }, 200);

        } catch (error) {
            session.stream.removeListener(
                'data',
                onData
            );

            reject(error);
        }

        setTimeout(() => {
            if (!finished) {
                session.stream.removeListener(
                    'data',
                    onData
                );

                session.userQueryBuffer =
                    [];

                reject(
                    new Error(
                        'Timeout clientlist'
                    )
                );
            }
        }, 5000);
    });
}

// ============================================================
// OBTENER USUARIOS
// ============================================================

async function getTsUsers(chatId = null) {
    try {
        if (
            chatId &&
            tsChatSessions[chatId]
        ) {
            const users =
                await getTsUsersFromSession(
                    tsChatSessions[chatId]
                );

            console.log(
                '[TS USERS]',
                users.map(
                    user =>
                        user.nickname
                )
            );

            return users;
        }

        /*
         * Si no hay chat abierto, abrimos temporalmente
         * una conexión ServerQuery.
         */

        const query =
            await createTsQuerySession();

        const session = {
            conn:
                query.conn,
            stream:
                query.stream
        };

        const users =
            await getTsUsersFromSession(
                session
            );

        try {
            query.conn.end();
        } catch (e) {}

        return users;

    } catch (error) {
        console.error(
            '[TS USERS]',
            error.message
        );

        return [];
    }
}

// ============================================================
// ESTADO TEAMSPEAK REAL
// ============================================================

async function isTeamSpeakOnline() {
    try {
        const query =
            await createTsQuerySession();

        const session = query;

        let buffer = '';

        return await new Promise(resolve => {
            let done = false;

            const finish =
                value => {
                    if (done) return;

                    done = true;

                    try {
                        session.conn.end();
                    } catch (e) {}

                    resolve(value);
                };

            session.stream.on(
                'data',
                data => {
                    buffer += removeAnsi(
                        data.toString()
                    );

                    const lines =
                        buffer.split(
                            /\r?\n/
                        );

                    buffer =
                        lines.pop() || '';

                    for (const rawLine of lines) {
                        const line =
                            rawLine.trim();

                        if (
                            line.startsWith(
                                'error id='
                            )
                        ) {
                            const fields =
                                parseTsFields(
                                    line.replace(
                                        /^error\s+/,
                                        ''
                                    )
                                );

                            const code =
                                Number(
                                    fields.id || 0
                                );

                            finish(
                                code === 0
                            );

                            return;
                        }
                    }
                }
            );

            session.stream.write(
                `use ${TS_SERVER_ID}\n`
            );

            setTimeout(() => {
                try {
                    session.stream.write(
                        'serverinfo\n'
                    );
                } catch (e) {
                    finish(false);
                }
            }, 300);

            setTimeout(() => {
                finish(false);
            }, 5000);
        });

    } catch (error) {
        console.error(
            '[TS STATUS]',
            error.message
        );

        return false;
    }
}

// ============================================================
// CHAT TEAMSPEAK
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
// ACTUALIZAR CHAT
// ============================================================

function updateChatPanel(chatId) {
    const session =
        tsChatSessions[chatId];

    if (
        !session ||
        !session.panelId
    ) {
        return;
    }

    const lines =
        session.messages.length

            ? session.messages
                .slice(-12)
                .map(message => {
                    const name =
                        escapeTelegramHtml(
                            message.name
                        );

                    const text =
                        escapeTelegramHtml(
                            message.text
                        );

                    return (
                        `<b>${name}</b>: ${text}`
                    );
                })
                .join('\n')

            : '💬 Todavía no hay mensajes nuevos.';

    const text =
        `<b>💬 CHAT TEAMSPEAK</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `${lines}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `✏️ Escribe un mensaje y se enviará al servidor.\n` +
        `👥 Pulsa <b>Usuarios conectados</b> para ver quién está en TeamSpeak.`;

    const keyboard = [
        [
            {
                text:
                    '👥 Usuarios conectados',
                callback_data:
                    'ts_chat_users'
            }
        ],
        [
            {
                text:
                    '🔴 Cerrar chat',
                callback_data:
                    'ts_chat_close'
            }
        ]
    ];

    bot.editMessageText(
        text,
        {
            chat_id:
                chatId,
            message_id:
                session.panelId,
            parse_mode:
                'HTML',
            reply_markup: {
                inline_keyboard:
                    keyboard
            }
        }
    ).catch(error => {
        if (
            !String(error.message)
                .includes(
                    'message is not modified'
                )
        ) {
            console.error(
                '[TELEGRAM PANEL]',
                error.message
            );
        }
    });
}

// ============================================================
// ABRIR CHAT TEAMSpeak
// ============================================================

function openTsChat(chatId) {
    return new Promise(
        (resolve, reject) => {

            if (
                tsChatSessions[chatId]
            ) {
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

            conn.on(
                'ready',
                () => {

                    console.log(
                        '[TS CHAT] SSH conectado'
                    );

                    conn.shell(
                        false,
                        (err, stream) => {

                            if (err) {
                                closeTsChat(
                                    chatId
                                );

                                reject(err);

                                return;
                            }

                            session.stream =
                                stream;

                            console.log(
                                '[TS CHAT] Shell abierto'
                            );

                            stream.on(
                                'data',
                                data => {

                                    let raw =
                                        removeAnsi(
                                            data.toString()
                                        );

                                    console.log(
                                        '[TS RAW]',
                                        JSON.stringify(
                                            raw
                                        )
                                    );

                                    session.buffer +=
                                        raw;

                                    const lines =
                                        session.buffer
                                            .split(
                                                /\r?\n/
                                            );

                                    session.buffer =
                                        lines.pop() ||
                                        '';

                                    for (
                                        const rawLine
                                        of lines
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

                                        if (
                                            !line.startsWith(
                                                'notifytextmessage'
                                            )
                                        ) {
                                            continue;
                                        }

                                        const eventLine =
                                            line.replace(
                                                /^notifytextmessage\s*/,
                                                ''
                                            );

                                        const fields =
                                            parseTsFields(
                                                eventLine
                                            );

                                        console.log(
                                            '[TS EVENT PARSED]',
                                            JSON.stringify(
                                                fields
                                            )
                                        );

                                        const message =
                                            fields.msg ||
                                            '';

                                        const name =
                                            fields.invokername ||
                                            fields.invokeruid ||
                                            'Usuario';

                                        if (!message) {
                                            continue;
                                        }

                                        if (
                                            fields.invokername ===
                                            TS_USER
                                        ) {
                                            console.log(
                                                '[TS EVENT] Ignorado: mensaje propio'
                                            );

                                            continue;
                                        }

                                        session.messages.push({
                                            name,
                                            text:
                                                message
                                        });

                                        if (
                                            session.messages.length >
                                            20
                                        ) {
                                            session.messages.shift();
                                        }

                                        updateChatPanel(
                                            chatId
                                        );
                                    }
                                }
                            );

                            stream.on(
                                'close',
                                () => {

                                    console.log(
                                        '[TS CHAT] Stream cerrado'
                                    );

                                    delete tsChatSessions[
                                        chatId
                                    ];
                                }
                            );

                            stream.on(
                                'error',
                                error => {

                                    console.error(
                                        '[TS STREAM ERROR]',
                                        error.message
                                    );

                                    closeTsChat(
                                        chatId
                                    );
                                }
                            );

                            stream.write(
                                `use ${TS_SERVER_ID}\n`
                            );

                            console.log(
                                `[TS CHAT] Seleccionando servidor ${TS_SERVER_ID}`
                            );

                            setTimeout(() => {

                                stream.write(
                                    `servernotifyregister event=textchannel id=${TS_CHANNEL_ID}\n`
                                );

                                console.log(
                                    '[TS CHAT] Suscripción enviada'
                                );

                                resolve();

                            }, 800);
                        }
                    );
                }
            );

            conn.on(
                'error',
                error => {

                    console.error(
                        '[TS SSH ERROR]',
                        error.message
                    );

                    closeTsChat(
                        chatId
                    );

                    reject(error);
                }
            );

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
        }
    );
}

// ============================================================
// ENVIAR MENSAJE TEAMSpeak
// ============================================================

function sendTsMessage(
    chatId,
    message
) {
    return new Promise(
        (resolve, reject) => {

            const session =
                tsChatSessions[chatId];

            if (
                !session ||
                !session.stream
            ) {
                reject(
                    new Error(
                        'Chat TeamSpeak cerrado'
                    )
                );

                return;
            }

            const command =
                `sendtextmessage ` +
                `targetmode=2 ` +
                `target=${TS_CHANNEL_ID} ` +
                `msg=${tsEscape(message)}\n`;

            console.log(
                '[TS SEND]',
                command.trim()
            );

            try {
                session.stream.write(
                    command
                );

                resolve();

            } catch (error) {
                reject(error);
            }
        }
    );
}

// ============================================================
// PANEL PRINCIPAL
// ============================================================

async function sendMainMenu(
    chatId,
    editMessageId = null
) {
    const role =
        authSessions[chatId]?.role;

    const hw =
        await getHardwareStats();

    const tsOnline =
        await isTeamSpeakOnline();

    const tsStatus =
        tsOnline
            ? '🟢 ONLINE'
            : '🔴 OFFLINE';

    const text =
        `<b>🏠 PANEL DE CONTROL</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 Acceso: <b>${
            role === 'admin'
                ? 'Administrador'
                : 'Invitado'
        }</b>\n\n` +

        `<b>📊 ESTADO DEL SERVIDOR</b>\n\n` +

        `🌡️ CPU <b>${
            escapeTelegramHtml(hw.cpu)
        }°C</b>\n` +
        `${drawBar(
            hw.cpu === 'N/D'
                ? 0
                : hw.cpu
        )}\n\n` +

        `🎮 GPU <b>${
            escapeTelegramHtml(hw.gpu)
        }°C</b>` +

        `${
            hw.gpuUtil !== 'N/D'
                ? ` · ${escapeTelegramHtml(hw.gpuUtil)}%`
                : ''
        }\n\n` +

        `🧠 RAM <b>${
            escapeTelegramHtml(hw.ramP)
        }%</b>\n` +
        `${drawBar(
            hw.ramP === 'N/D'
                ? 0
                : hw.ramP
        )}\n\n` +

        `💾 Disco <b>${
            escapeTelegramHtml(hw.diskP)
        }%</b>\n` +
        `${drawBar(
            hw.diskP === 'N/D'
                ? 0
                : hw.diskP
        )}\n\n` +

        `📡 Ping <b>${
            escapeTelegramHtml(hw.ping)
        } ms</b>\n` +

        `⏱️ Uptime <b>${
            escapeTelegramHtml(hw.uptime)
        }</b>\n\n` +

        `<b>🎙️ TeamSpeak</b> ${tsStatus}\n\n` +

        `Selecciona una sección:`;

    const keyboard = [

        [
            {
                text:
                    '🖥️ Servidores',
                callback_data:
                    'menu_servers'
            },
            {
                text:
                    '👥 TeamSpeak',
                callback_data:
                    'menu_ts'
            }
        ],

        [
            {
                text:
                    '💬 Chat TeamSpeak',
                callback_data:
                    'menu_chat'
            },
            {
                text:
                    '🔄 Actualizar estado',
                callback_data:
                    'menu_home'
            }
        ]
    ];

    if (
        role === 'admin'
    ) {
        keyboard.push([
            {
                text:
                    '🔥 Top procesos',
                callback_data:
                    'sys_top'
            },
            {
                text:
                    '🚀 Speedtest',
                callback_data:
                    'sys_speedtest'
            }
        ]);

        keyboard.push([
            {
                text:
                    '🛰️ Reiniciar PC',
                callback_data:
                    'sys_reboot'
            },
            {
                text:
                    '💀 Apagar PC',
                callback_data:
                    'sys_poweroff'
            }
        ]);
    }

    const options = {
        parse_mode:
            'HTML',
        reply_markup: {
            inline_keyboard:
                keyboard
        }
    };

    if (
        editMessageId
    ) {

        try {
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
        } catch (error) {

            if (
                !String(error.message)
                    .includes(
                        'message is not modified'
                    )
            ) {
                throw error;
            }
        }

    } else {

        await bot.sendMessage(
            chatId,
            text,
            options
        );
    }
}

// ============================================================
// SERVIDORES PTERODACTYL
// ============================================================

async function showServers(
    chatId,
    editMessageId = null
) {

    const servers =
        await getServers();

    let online = 0;

    for (
        const server
        of servers
    ) {

        const state =
            server.attributes.current_state;

        /*
         * En tu TeamSpeak 6 Pterodactyl deja el estado en
         * "starting" aunque realmente esté funcionando.
         *
         * Para el panel tratamos "starting" como activo.
         */

        const active =
            state === 'running' ||
            state === 'starting';

        if (active) {
            online++;
        }
    }

    let text =
        `<b>🖥️ SERVIDORES ${online}/${servers.length}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n`;

    const keyboard = [];

    for (
        const server
        of servers
    ) {

        const a =
            server.attributes;

        const id =
            a.identifier;

        const state =
            a.current_state ||
            'unknown';

        const active =
            state === 'running' ||
            state === 'starting';

        let icon = '⚪';

        if (
            state === 'running'
        ) {
            icon = '🟢';
        } else if (
            state === 'starting'
        ) {
            icon = '🟡';
        } else if (
            state === 'stopping'
        ) {
            icon = '🟠';
        } else if (
            state === 'offline'
        ) {
            icon = '🔴';
        }

        text +=
            `${icon} <b>${escapeTelegramHtml(a.name)}</b>\n` +
            `Estado: <b>${escapeTelegramHtml(state)}</b>\n\n`;

        if (active) {

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

        } else if (
            state === 'stopping' ||
            state === 'offline'
        ) {

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
            'HTML',
        reply_markup: {
            inline_keyboard:
                keyboard
        }
    };

    if (editMessageId) {

        try {

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

        } catch (error) {

            if (
                !String(error.message)
                    .includes(
                        'message is not modified'
                    )
            ) {
                throw error;
            }
        }

    } else {

        await bot.sendMessage(
            chatId,
            text,
            options
        );
    }
}

// ============================================================
// USUARIOS
// ============================================================

async function showTsUsers(
    chatId,
    returnToChat = false
) {

    const users =
        await getTsUsers(
            returnToChat
                ? chatId
                : null
        );

    let text =
        `<b>👥 USUARIOS CONECTADOS</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n`;

    if (
        users.length === 0
    ) {

        text +=
            `😴 No hay usuarios normales conectados.\n\n` +
            `💡 Los clientes ServerQuery no aparecen.`;

    } else {

        text +=
            users
                .map(
                    (user, index) =>
                        `${index + 1}. 🟢 <b>${escapeTelegramHtml(user.nickname)}</b>`
                )
                .join('\n');
    }

    const keyboard = [];

    if (
        returnToChat
    ) {

        keyboard.push([
            {
                text:
                    '💬 Volver al chat',
                callback_data:
                    'menu_chat'
            }
        ]);

    } else {

        keyboard.push([
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
        ]);
    }

    keyboard.push([
        {
            text:
                '◀️ Volver',
            callback_data:
                'menu_home'
        }
    ]);

    await bot.sendMessage(
        chatId,
        text,
        {
            parse_mode:
                'HTML',
            reply_markup: {
                inline_keyboard:
                    keyboard
            }
        }
    );
}

// ============================================================
// SPEEDTEST
// ============================================================

async function runSpeedtest() {

    const result =
        await sshExec(
            `
if command -v speedtest >/dev/null 2>&1; then
    speedtest
elif command -v speedtest-cli >/dev/null 2>&1; then
    speedtest-cli --simple
else
    echo "SPEEDTEST_NOT_FOUND"
fi
`,
            120000
        );

    return result.stdout.trim();
}

// ============================================================
// TOP PROCESOS
// ============================================================

async function getTopProcesses() {

    const result =
        await sshExec(
            'ps -eo pcpu,pmem,comm --sort=-pcpu | head -n 8',
            10000
        );

    return result.stdout.trim();
}

// ============================================================
// EJECUTAR REINICIO/APAGADO
// ============================================================

async function executeSystemAction(
    chatId,
    action
) {

    await bot.sendMessage(
        chatId,
        `⚠️ Ejecutando <b>${escapeTelegramHtml(action)}</b>...`,
        {
            parse_mode:
                'HTML'
        }
    );

    try {

        await sshExec(
            `sudo ${action}`,
            5000
        );

    } catch (error) {

        console.error(
            '[SYSTEM ACTION]',
            error.message
        );

        /*
         * En reboot/poweroff es normal que SSH desaparezca
         * antes de recibir la respuesta.
         */
    }
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

        if (
            !isAuthenticated(chatId)
        ) {

            await bot.sendMessage(
                chatId,
                `<b>🔐 ACCESO AL PANEL</b>\n\n` +
                `Introduce la contraseña de invitado o administrador:`,
                {
                    parse_mode:
                        'HTML'
                }
            );

            return;
        }

        await sendMainMenu(
            chatId
        );
    }
);

// ============================================================
// MENSAJES TELEGRAM
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

        if (
            text.startsWith('/')
        ) {
            return;
        }

        // ------------------------------------------------------
        // AUTENTICACIÓN
        // ------------------------------------------------------

        if (
            !isAuthenticated(chatId)
        ) {

            if (
                text === ADMIN_PASSWORD
            ) {

                authSessions[chatId] = {
                    role:
                        'admin'
                };

                await bot.sendMessage(
                    chatId,
                    `<b>🔓 Acceso de administrador concedido.</b>`,
                    {
                        parse_mode:
                            'HTML'
                    }
                );

                await sendMainMenu(
                    chatId
                );

                return;
            }

            if (
                text === GUEST_PASSWORD
            ) {

                authSessions[chatId] = {
                    role:
                        'guest'
                };

                await bot.sendMessage(
                    chatId,
                    `<b>🔓 Acceso de invitado concedido.</b>`,
                    {
                        parse_mode:
                            'HTML'
                    }
                );

                await sendMainMenu(
                    chatId
                );

                return;
            }

            await bot.sendMessage(
                chatId,
                '❌ Contraseña incorrecta.'
            );

            return;
        }

        // ------------------------------------------------------
        // CHAT TEAMSpeak
        // ------------------------------------------------------

        if (
            tsChatSessions[chatId]
        ) {

            if (
                text.length > 300
            ) {

                await bot.sendMessage(
                    chatId,
                    '⚠️ El mensaje es demasiado largo. Máximo 300 caracteres.'
                );

                return;
            }

            try {

                await sendTsMessage(
                    chatId,
                    text
                );

                const session =
                    tsChatSessions[chatId];

                session.messages.push({
                    name:
                        'Tú',
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

            } catch (error) {

                console.error(
                    '[TELEGRAM -> TS]',
                    error.message
                );

                await bot.sendMessage(
                    chatId,
                    '❌ No se pudo enviar el mensaje a TeamSpeak.'
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
        // HOME
        // ====================================================

        if (
            data === 'menu_home'
        ) {

            try {

                await sendMainMenu(
                    chatId,
                    messageId
                );

            } catch (error) {

                console.error(
                    '[MAIN MENU]',
                    error.message
                );
            }

            return;
        }

        // ====================================================
        // SERVIDORES
        // ====================================================

        if (
            data === 'menu_servers'
        ) {

            try {

                await showServers(
                    chatId,
                    messageId
                );

            } catch (error) {

                console.error(
                    '[PTERODACTYL]',
                    error.message
                );

                /*
                 * Solo mostramos este mensaje si el error es
                 * realmente de la consulta a Pterodactyl.
                 *
                 * "message is not modified" se ignora dentro
                 * de showServers().
                 */

                await bot.sendMessage(
                    chatId,
                    '🔴 No se pudo consultar Pterodactyl.'
                );
            }

            return;
        }

        // ====================================================
        // TEAMSPEAK USERS
        // ====================================================

        if (
            data === 'menu_ts'
        ) {

            try {

                await showTsUsers(
                    chatId
                );

            } catch (error) {

                console.error(
                    '[TS USERS]',
                    error.message
                );

                await bot.sendMessage(
                    chatId,
                    '🔴 No se pudo consultar TeamSpeak.'
                );
            }

            return;
        }

        // ====================================================
        // CHAT
        // ====================================================

        if (
            data === 'menu_chat'
        ) {

            try {

                if (
                    tsChatSessions[chatId]
                ) {

                    tsChatSessions[
                        chatId
                    ].panelId =
                        messageId;

                    updateChatPanel(
                        chatId
                    );

                    return;
                }

                await bot.editMessageText(

                    `<b>💬 Conectando al chat de TeamSpeak...</b>\n\n` +
                    `⏳ Abriendo conexión en tiempo real...`,

                    {
                        chat_id:
                            chatId,
                        message_id:
                            messageId,
                        parse_mode:
                            'HTML'
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

            } catch (error) {

                console.error(
                    '[TS CHAT]',
                    error
                );

                closeTsChat(
                    chatId
                );

                try {

                    await bot.editMessageText(

                        `<b>🔴 No se pudo conectar al chat de TeamSpeak.</b>\n\n` +
                        `Comprueba que el puerto ${TS_PORT} esté accesible desde Northflank.`,

                        {
                            chat_id:
                                chatId,
                            message_id:
                                messageId,
                            parse_mode:
                                'HTML',
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

                } catch (editError) {

                    console.error(
                        '[TS CHAT ERROR MESSAGE]',
                        editError.message
                    );
                }
            }

            return;
        }

        // ====================================================
        // CERRAR CHAT
        // ====================================================

        if (
            data === 'ts_chat_close'
        ) {

            closeTsChat(
                chatId
            );

            await bot.editMessageText(
                `<b>💬 Chat TeamSpeak cerrado.</b>`,
                {
                    chat_id:
                        chatId,
                    message_id:
                        messageId,
                    parse_mode:
                        'HTML',
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
            ).catch(() => {});

            return;
        }

        // ====================================================
        // USUARIOS DESDE CHAT
        // ====================================================

        if (
            data === 'ts_chat_users'
        ) {

            await showTsUsers(
                chatId,
                true
            );

            return;
        }

        // ====================================================
        // ACTUALIZAR USUARIOS
        // ====================================================

        if (
            data === 'menu_ts_refresh'
        ) {

            await showTsUsers(
                chatId
            );

            return;
        }

        // ====================================================
        // ACCIONES PTERODACTYL
        // ====================================================

        if (
            data.startsWith('srv_')
        ) {

            if (
                !requireAdmin(chatId)
            ) {

                await bot.sendMessage(
                    chatId,
                    '🔒 Esta acción requiere permisos de administrador.'
                );

                return;
            }

            const parts =
                data.split('_');

            const action =
                parts[1];

            const serverId =
                parts[2];

            // --------------------------------------------------
            // STOP / RESTART
            // --------------------------------------------------

            if (
                action === 'stop' ||
                action === 'restart'
            ) {

                const users =
                    await getTsUsers(
                        chatId
                    );

                if (
                    users.length > 0
                ) {

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
                                user =>
                                    `• ${escapeTelegramHtml(user.nickname)}`
                            )
                            .join('\n');

                    await bot.sendMessage(

                        chatId,

                        `<b>⚠️ HAY USUARIOS CONECTADOS</b>\n\n` +
                        `TeamSpeak tiene actualmente <b>${users.length}</b> usuario(s):\n\n` +
                        `${names}\n\n` +
                        `¿Quieres continuar con la operación?`,

                        {
                            parse_mode:
                                'HTML',

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

                const response =
                    await powerServer(
                        serverId,
                        action
                    );

                if (
                    !response.ok
                ) {
                    throw new Error(
                        `Pterodactyl HTTP ${response.status}`
                    );
                }

                await bot.sendMessage(
                    chatId,
                    `✅ <b>${escapeTelegramHtml(
                        action.toUpperCase()
                    )}</b> enviado correctamente.`,
                    {
                        parse_mode:
                            'HTML'
                    }
                );

            } catch (error) {

                console.error(
                    '[PTERODACTYL POWER]',
                    error.message
                );

                await bot.sendMessage(
                    chatId,
                    `❌ No se pudo ejecutar <b>${escapeTelegramHtml(action)}</b> en Pterodactyl.`,
                    {
                        parse_mode:
                            'HTML'
                    }
                );
            }

            return;
        }

        // ====================================================
        // CONFIRMAR SERVER
        // ====================================================

        if (
            data === 'confirm_server'
        ) {

            if (
                !requireAdmin(chatId)
            ) {
                return;
            }

            const pending =
                pendingActions[chatId];

            if (!pending) {

                await bot.sendMessage(
                    chatId,
                    '⚠️ La operación ya no está disponible.'
                );

                return;
            }

            delete pendingActions[
                chatId
            ];

            try {

                const response =
                    await powerServer(
                        pending.serverId,
                        pending.action
                    );

                if (
                    !response.ok
                ) {
                    throw new Error(
                        `Pterodactyl HTTP ${response.status}`
                    );
                }

                await bot.sendMessage(

                    chatId,

                    `✅ <b>${escapeTelegramHtml(
                        pending.action.toUpperCase()
                    )}</b> enviado.`,

                    {
                        parse_mode:
                            'HTML'
                    }
                );

            } catch (error) {

                console.error(
                    '[PTERODACTYL CONFIRM]',
                    error.message
                );

                await bot.sendMessage(
                    chatId,
                    '❌ No se pudo ejecutar la operación.'
                );
            }

            return;
        }

        // ====================================================
        // CANCELAR
        // ====================================================

        if (
            data === 'cancel_action'
        ) {

            delete pendingActions[
                chatId
            ];

            await bot.sendMessage(
                chatId,
                '❌ Operación cancelada.'
            );

            return;
        }

        // ====================================================
        // TOP PROCESOS
        // ====================================================

        if (
            data === 'sys_top'
        ) {

            if (
                !requireAdmin(chatId)
            ) {
                return;
            }

            try {

                const result =
                    await getTopProcesses();

                await bot.sendMessage(
                    chatId,
                    `<b>🔥 TOP PROCESOS</b>\n\n` +
                    `<pre>${escapeTelegramHtml(result)}</pre>`,
                    {
                        parse_mode:
                            'HTML'
                    }
                );

            } catch (error) {

                console.error(
                    '[TOP]',
                    error.message
                );

                await bot.sendMessage(
                    chatId,
                    '❌ No se pudo obtener el top de procesos.'
                );
            }

            return;
        }

        // ====================================================
        // SPEEDTEST
        // ====================================================

        if (
            data === 'sys_speedtest'
        ) {

            if (
                !requireAdmin(chatId)
            ) {
                return;
            }

            const testing =
                await bot.sendMessage(
                    chatId,
                    '🌐 Ejecutando Speedtest...\n⏳ Puede tardar un poco.'
                );

            try {

                const result =
                    await runSpeedtest();

                if (
                    result.includes(
                        'SPEEDTEST_NOT_FOUND'
                    )
                ) {

                    throw new Error(
                        'No se encontró speedtest'
                    );
                }

                await bot.editMessageText(

                    `<b>🚀 SPEEDTEST</b>\n\n` +
                    `<pre>${escapeTelegramHtml(result)}</pre>`,

                    {
                        chat_id:
                            chatId,

                        message_id:
                            testing.message_id,

                        parse_mode:
                            'HTML'
                    }
                );

            } catch (error) {

                console.error(
                    '[SPEEDTEST]',
                    error.message
                );

                await bot.editMessageText(
                    `❌ No se pudo ejecutar Speedtest.`,
                    {
                        chat_id:
                            chatId,
                        message_id:
                            testing.message_id
                    }
                ).catch(() => {});
            }

            return;
        }

        // ====================================================
        // REBOOT / POWEROFF
        // ====================================================

        if (
            data === 'sys_reboot' ||
            data === 'sys_poweroff'
        ) {

            if (
                !requireAdmin(chatId)
            ) {
                return;
            }

            const action =
                data === 'sys_reboot'
                    ? 'reboot'
                    : 'poweroff';

            const users =
                await getTsUsers(
                    chatId
                );

            if (
                users.length > 0
            ) {

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
                            user =>
                                `• ${escapeTelegramHtml(user.nickname)}`
                        )
                        .join('\n');

                await bot.sendMessage(

                    chatId,

                    `<b>⚠️ USUARIOS CONECTADOS A TEAMSPEAK</b>\n\n` +
                    `${names}\n\n` +
                    `Hay <b>${users.length}</b> usuario(s) conectado(s).\n\n` +
                    `¿Seguro que quieres ${
                        action === 'reboot'
                            ? 'reiniciar'
                            : 'apagar'
                    } el PC?`,

                    {
                        parse_mode:
                            'HTML',

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

        if (
            data === 'confirm_system'
        ) {

            if (
                !requireAdmin(chatId)
            ) {
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
// MENSAJE DE ARRANQUE
// ============================================================

async function sendStartupMessage() {

    const chatId =
        process.env.STARTUP_MESSAGE_CHAT_ID;

    if (!chatId) {
        return;
    }

    const hw =
        await getHardwareStats();

    const tsOnline =
        await isTeamSpeakOnline();

    const text =
        `<b>✅ SISTEMA ONLINE</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +

        `🌡️ CPU: <b>${escapeTelegramHtml(hw.cpu)}°C</b>\n` +
        `🎮 GPU: <b>${escapeTelegramHtml(hw.gpu)}°C</b>\n` +
        `🧠 RAM: <b>${escapeTelegramHtml(hw.ramP)}%</b>\n` +
        `📡 Ping: <b>${escapeTelegramHtml(hw.ping)} ms</b>\n` +
        `💾 Disco: <b>${escapeTelegramHtml(hw.diskP)}%</b>\n\n` +

        `🎙️ TeamSpeak: <b>${
            tsOnline
                ? 'ONLINE'
                : 'OFFLINE'
        }</b>\n\n` +

        `🤖 El bot de monitorización está operativo.`;

    try {

        await bot.sendMessage(
            chatId,
            text,
            {
                parse_mode:
                    'HTML'
            }
        );

    } catch (error) {

        console.error(
            '[STARTUP]',
            error.message
        );
    }
}

// ============================================================
// ERRORES
// ============================================================

bot.on(
    'polling_error',
    error => {

        console.error(
            '[TELEGRAM POLLING]',
            error.message
        );
    }
);

process.on(
    'unhandledRejection',
    error => {

        console.error(
            '[UNHANDLED REJECTION]',
            error
        );
    }
);

process.on(
    'uncaughtException',
    error => {

        console.error(
            '[UNCAUGHT EXCEPTION]',
            error
        );
    }
);

// ============================================================
// ARRANQUE
// ============================================================

console.log(
    '🤖 Bot iniciado correctamente.'
);

console.log(
    `[CONFIG] TS ${TS_HOST}:${TS_PORT} server=${TS_SERVER_ID} channel=${TS_CHANNEL_ID}`
);

sendStartupMessage()
    .catch(error => {
        console.error(
            '[STARTUP MESSAGE]',
            error.message
        );
    });
