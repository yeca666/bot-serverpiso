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

const ADMIN_PASSWORD =
    process.env.adminpassword;

const GUEST_PASSWORD =
    process.env.guestpassword;

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
// ESTADOS
// ============================================================

const authSessions = {};
const tsChatSessions = {};
const pendingActions = {};

// ============================================================
// UTILIDADES
// ============================================================

function drawBar(percentage, size = 10) {

    const pct = Math.max(
        0,
        Math.min(
            100,
            Number(percentage) || 0
        )
    );

    const filled =
        Math.round(
            (pct / 100) * size
        );

    return (
        '▰'.repeat(filled) +
        '▱'.repeat(size - filled)
    );
}

// ------------------------------------------------------------
// HTML TELEGRAM
// ------------------------------------------------------------

function escapeTelegramHtml(text) {

    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ------------------------------------------------------------
// MARKDOWN TELEGRAM
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// ANSI
// ------------------------------------------------------------

function removeAnsi(text) {

    return String(text).replace(
        /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,
        ''
    );
}

// ============================================================
// TEAMSPEAK DECODIFICACIÓN
// ============================================================

function decodeTs(value) {

    if (
        value === undefined ||
        value === null
    ) {
        return '';
    }

    const text = String(value);

    let result = '';

    for (
        let i = 0;
        i < text.length;
        i++
    ) {

        if (text[i] !== '\\') {

            result += text[i];

            continue;
        }

        const next =
            text[i + 1];

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
// TEAMSPEAK ESCAPAR
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
// PARSER TEAMSPEAK
// ============================================================

function parseTsFields(line) {

    const fields = {};

    /*
     * Ejemplo real:
     *
     * targetmode=2 msg=test invokerid=10
     * invokername=Yeray_03 invokeruid=...
     *
     * Los campos están separados por espacios.
     * Los espacios internos están escapados como \s.
     */

    const regex =
        /([a-zA-Z0-9_]+)=((?:\\.|[^\s])*)/g;

    let match;

    while (
        (match = regex.exec(line)) !== null
    ) {

        fields[match[1]] =
            decodeTs(match[2]);
    }

    return fields;
}

// ============================================================
// SPLIT DE RESPUESTAS TEAMSpeak
// ============================================================

function splitTsPipeLine(line) {

    const result = [];

    let current = '';
    let escaped = false;

    for (
        let i = 0;
        i < line.length;
        i++
    ) {

        const char =
            line[i];

        if (escaped) {

            current +=
                '\\' + char;

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

    if (escaped) {
        current += '\\';
    }

    result.push(current);

    return result;
}

// ============================================================
// LIMPIAR HISTORIAL
// ============================================================

async function limpiarHistorial(
    chatId,
    lastMsgId
) {

    for (
        let i = 0;
        i < 50;
        i++
    ) {

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
    return (
        authSessions[chatId]?.role === 'admin'
    );
}

function requireAdmin(chatId) {
    return isAdmin(chatId);
}

// ============================================================
// SSH GENÉRICO HOST
// ============================================================

function sshExec(command, timeout = 7000) {

    return new Promise((resolve, reject) => {

        const conn =
            new Client();

        let settled = false;

        const finishResolve = value => {

            if (settled) {
                return;
            }

            settled = true;

            try {
                conn.end();
            } catch (e) {}

            resolve(value);
        };

        const finishReject = error => {

            if (settled) {
                return;
            }

            settled = true;

            try {
                conn.end();
            } catch (e) {}

            reject(error);
        };

        const timer = setTimeout(() => {

            finishReject(
                new Error(
                    'SSH timeout'
                )
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

                    stream.on(
                        'data',
                        data => {
                            stdout +=
                                data.toString();
                        }
                    );

                    stream.stderr.on(
                        'data',
                        data => {
                            stderr +=
                                data.toString();
                        }
                    );

                    stream.on(
                        'close',
                        () => {

                            clearTimeout(timer);

                            finishResolve({
                                stdout,
                                stderr
                            });
                        }
                    );
                }
            );
        });

        conn.on('error', error => {

            clearTimeout(timer);

            finishReject(error);
        });

        conn.connect({

            host:
                sshHost,

            port:
                2222,

            username:
                sshUser,

            password:
                sshPass,

            readyTimeout:
                5000
        });
    });
}

// ============================================================
// MONITOR DEL HOST
// ============================================================

async function getHardwareStats() {

    try {

        const command = `
echo "__TEMP__"
sensors 2>/dev/null

echo "__GPU__"
if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits 2>/dev/null | head -n 1
fi

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

        const result =
            await sshExec(
                command,
                9000
            );

        const output =
            result.stdout || '';

        // ------------------------------------------------------
        // CPU
        // ------------------------------------------------------

        let cpu = 'N/D';

        const cpuMatches = [
            output.match(
                /Package id 0:\s+\+?([\d.]+)\s*°?C/i
            ),

            output.match(
                /Tctl:\s+\+?([\d.]+)\s*°?C/i
            ),

            output.match(
                /CPU(?: Temperature| Temp)?[^+\d]*\+?([\d.]+)\s*°?C/i
            ),

            output.match(
                /temp1:\s+\+?([\d.]+)\s*°?C/i
            )
        ];

        for (
            const match of cpuMatches
        ) {

            if (match) {

                cpu =
                    Number(match[1])
                        .toFixed(1);

                break;
            }
        }

        // ------------------------------------------------------
        // GPU
        // ------------------------------------------------------

        let gpu = 'N/D';

        const gpuMatch =
            output.match(
                /__GPU__\s*[\r\n]+([0-9]+(?:\.[0-9]+)?)/m
            );

        if (gpuMatch) {

            gpu =
                Number(
                    gpuMatch[1]
                ).toFixed(1);
        } else {

            const genericGpu =
                output.match(
                    /(?:edge|junction|GPU)[^+\d]*\+?([\d.]+)\s*°?C/i
                );

            if (genericGpu) {

                gpu =
                    Number(
                        genericGpu[1]
                    ).toFixed(1);
            }
        }

        // ------------------------------------------------------
        // RAM
        // ------------------------------------------------------

        let ramPct = 'N/D';

        const ramMatch =
            output.match(
                /__RAM__[\s\S]*?Mem:\s+(\d+)\s+(\d+)/m
            );

        if (ramMatch) {

            const total =
                Number(ramMatch[1]);

            const used =
                Number(ramMatch[2]);

            if (total > 0) {

                ramPct =
                    (
                        (used / total) * 100
                    ).toFixed(1);
            }
        }

        // ------------------------------------------------------
        // PING
        // ------------------------------------------------------

        let ping = 'N/D';

        const pingMatch =
            output.match(
                /__PING__[\s\S]*?time[=<]([\d.]+)\s*ms/i
            );

        if (pingMatch) {

            ping =
                Number(
                    pingMatch[1]
                ).toFixed(1);
        }

        // ------------------------------------------------------
        // UPTIME
        // ------------------------------------------------------

        let uptime = 'N/D';

        const uptimeMatch =
            output.match(
                /__UPTIME__\s*[\r\n]+([^\r\n]+)/m
            );

        if (uptimeMatch) {

            uptime =
                uptimeMatch[1]
                    .trim()
                    .replace(
                        /days?/g,
                        'd'
                    )
                    .replace(
                        /hours?/g,
                        'h'
                    )
                    .replace(
                        /minutes?/g,
                        'm'
                    )
                    .replace(
                        /seconds?/g,
                        's'
                    );
        }

        // ------------------------------------------------------
        // DISCO
        // ------------------------------------------------------

        let disk = 'N/D';

        const diskMatch =
            output.match(
                /__DISK__[\s\S]*?\s(\d+)%\s+\/\s*$/m
            );

        if (diskMatch) {

            disk =
                Number(
                    diskMatch[1]
                );
        }

        return {

            cpu,
            gpu,
            ramP: ramPct,
            ping,
            up: uptime,
            diskP: disk

        };

    } catch (error) {

        console.error(
            '[HOST MONITOR]',
            error.message
        );

        return {

            cpu: 'N/D',
            gpu: 'N/D',
            ramP: 'N/D',
            ping: 'N/D',
            up: 'N/D',
            diskP: 'N/D'

        };
    }
}

// ============================================================
// PTERODACTYL
// ============================================================

async function getServers() {

    const response =
        await fetch(
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

    return data.data || [];
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
// SERVERQUERY SSH
// ============================================================

function tsQueryCommand(
    commands,
    timeout = 7000
) {

    return new Promise(
        (resolve, reject) => {

            const conn =
                new Client();

            let streamRef = null;
            let buffer = '';
            let outputLines = [];
            let settled = false;

            const finishResolve =
                value => {

                    if (settled) {
                        return;
                    }

                    settled = true;

                    try {
                        if (streamRef) {
                            streamRef.end();
                        }
                    } catch (e) {}

                    try {
                        conn.end();
                    } catch (e) {}

                    resolve(value);
                };

            const finishReject =
                error => {

                    if (settled) {
                        return;
                    }

                    settled = true;

                    try {
                        conn.end();
                    } catch (e) {}

                    reject(error);
                };

            const timer =
                setTimeout(
                    () => {

                        finishReject(
                            new Error(
                                'ServerQuery timeout'
                            )
                        );

                    },
                    timeout
                );

            conn.on('ready', () => {

                conn.shell(
                    false,
                    (err, stream) => {

                        if (err) {

                            clearTimeout(
                                timer
                            );

                            finishReject(err);

                            return;
                        }

                        streamRef =
                            stream;

                        stream.on(
                            'data',
                            data => {

                                let raw =
                                    removeAnsi(
                                        data.toString()
                                    );

                                buffer +=
                                    raw;

                                const lines =
                                    buffer.split(
                                        /\r?\n/
                                    );

                                buffer =
                                    lines.pop() || '';

                                for (
                                    const rawLine
                                    of lines
                                ) {

                                    const line =
                                        rawLine.trim();

                                    if (!line) {
                                        continue;
                                    }

                                    /*
                                     * Ignorar el prompt.
                                     */

                                    if (
                                        line.endsWith(
                                            '>'
                                        ) &&
                                        (
                                            line.includes(
                                                '@'
                                            ) ||
                                            line === '>'
                                        )
                                    ) {
                                        continue;
                                    }

                                    /*
                                     * TeamSpeak devuelve:
                                     *
                                     * error id=0 msg=ok
                                     *
                                     * al terminar un comando.
                                     */

                                    if (
                                        line.startsWith(
                                            'error id='
                                        )
                                    ) {

                                        const errorFields =
                                            parseTsFields(
                                                line
                                                    .replace(
                                                        /^error\s+/,
                                                        ''
                                                    )
                                            );

                                        const code =
                                            Number(
                                                errorFields.id ||
                                                0
                                            );

                                        if (
                                            code !== 0
                                        ) {

                                            clearTimeout(
                                                timer
                                            );

                                            finishReject(
                                                new Error(
                                                    line
                                                )
                                            );

                                            return;
                                        }

                                        clearTimeout(
                                            timer
                                        );

                                        finishResolve(
                                            outputLines
                                                .join(
                                                    '\n'
                                                )
                                        );

                                        return;
                                    }

                                    if (
                                        line === 'TS3'
                                    ) {
                                        continue;
                                    }

                                    if (
                                        line.startsWith(
                                            'Welcome to the TeamSpeak'
                                        )
                                    ) {
                                        continue;
                                    }

                                    outputLines.push(
                                        line
                                    );
                                }
                            }
                        );

                        stream.on(
                            'error',
                            error => {

                                clearTimeout(
                                    timer
                                );

                                finishReject(
                                    error
                                );
                            }
                        );

                        stream.write(
                            commands
                        );

                        if (
                            !commands.endsWith(
                                '\n'
                            )
                        ) {

                            stream.write(
                                '\n'
                            );
                        }
                    }
                );
            });

            conn.on(
                'error',
                error => {

                    clearTimeout(
                        timer
                    );

                    finishReject(
                        error
                    );
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
// OBTENER USUARIOS TEAMSpeak
// ============================================================

async function getTsUsers() {

    try {

        const output =
            await tsQueryCommand(
                `use ${TS_SERVER_ID}\nclientlist\n`,
                7000
            );

        console.log(
            '[TS USERS RAW]',
            output
        );

        const users = [];

        const chunks =
            output
                .split('|')
                .map(
                    x => x.trim()
                )
                .filter(Boolean);

        for (
            const chunk of chunks
        ) {

            if (
                !chunk.includes(
                    'client_type='
                )
            ) {
                continue;
            }

            const fields =
                parseTsFields(
                    chunk
                );

            const type =
                Number(
                    fields.client_type
                );

            const nickname =
                fields.client_nickname ||
                '';

            console.log(
                '[TS USERS]',
                nickname,
                'type=',
                type
            );

            if (
                type === 0
            ) {

                users.push({
                    nickname,
                    clid:
                        fields.clid || ''
                });
            }
        }

        console.log(
            '[TS USERS] Usuarios normales:',
            users.map(
                u => u.nickname
            )
        );

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
// PANEL DEL CHAT
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

        console.error(
            '[TELEGRAM PANEL]',
            error.message
        );
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

                                return reject(
                                    err
                                );
                            }

                            session.stream =
                                stream;

                            console.log(
                                '[TS CHAT] Shell abierto'
                            );

                            // ------------------------------------------------
                            // RECEPCIÓN
                            // ------------------------------------------------

                            stream.on(
                                'data',
                                data => {

                                    let raw =
                                        data.toString();

                                    console.log(
                                        '[TS RAW]',
                                        JSON.stringify(
                                            raw
                                        )
                                    );

                                    raw =
                                        removeAnsi(
                                            raw
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

                                        if (
                                            !message
                                        ) {

                                            continue;
                                        }

                                        /*
                                         * El mensaje que mandamos
                                         * desde Telegram ya se añade
                                         * como "Tú".
                                         *
                                         * Evitamos duplicarlo.
                                         */

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

                                    if (
                                        tsChatSessions[
                                            chatId
                                        ]
                                    ) {

                                        delete tsChatSessions[
                                            chatId
                                        ];
                                    }
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

                            // ------------------------------------------------
                            // SELECCIONAR SERVIDOR
                            // ------------------------------------------------

                            stream.write(
                                `use ${TS_SERVER_ID}\n`
                            );

                            console.log(
                                `[TS CHAT] Seleccionando servidor ${TS_SERVER_ID}`
                            );

                            // ------------------------------------------------
                            // SUSCRIBIRSE
                            // ------------------------------------------------

                            setTimeout(
                                () => {

                                    console.log(
                                        `[TS CHAT] Suscribiendo a textchannel del canal ${TS_CHANNEL_ID}`
                                    );

                                    stream.write(
                                        `servernotifyregister event=textchannel id=${TS_CHANNEL_ID}\n`
                                    );

                                    console.log(
                                        '[TS CHAT] Suscripción enviada'
                                    );

                                    resolve();

                                },
                                800
                            );
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

    const cpu =
        hw.cpu !== 'N/D'
            ? `🌡️ CPU <b>${escapeTelegramHtml(hw.cpu)}°C</b>`
            : '🌡️ CPU <b>N/D</b>';

    const gpu =
        hw.gpu !== 'N/D'
            ? `🎮 GPU <b>${escapeTelegramHtml(hw.gpu)}°C</b>`
            : '🎮 GPU <b>N/D</b>';

    const ram =
        hw.ramP !== 'N/D'
            ? `🧠 RAM <b>${escapeTelegramHtml(hw.ramP)}%</b>`
            : '🧠 RAM <b>N/D</b>';

    const ping =
        hw.ping !== 'N/D'
            ? `📡 Ping <b>${escapeTelegramHtml(hw.ping)} ms</b>`
            : '📡 Ping <b>N/D</b>';

    const disk =
        hw.diskP !== 'N/D'
            ? `💾 Disco <b>${escapeTelegramHtml(hw.diskP)}%</b>`
            : '💾 Disco <b>N/D</b>';

    const uptime =
        `⏱️ Uptime <b>${escapeTelegramHtml(hw.up)}</b>`;

    const text =
        `<b>🏠 PANEL DE CONTROL</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 Acceso: <b>${
            role === 'admin'
                ? 'Administrador'
                : 'Invitado'
        }</b>\n\n` +

        `<b>📊 ESTADO DEL SERVIDOR</b>\n` +
        `${cpu}\n` +
        `${drawBar(hw.cpu === 'N/D' ? 0 : hw.cpu)}\n\n` +

        `${gpu}\n` +
        `${ram}\n` +
        `${drawBar(hw.ramP === 'N/D' ? 0 : hw.ramP)}\n\n` +

        `${ping}\n` +
        `${disk}\n` +
        `${uptime}\n\n` +

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

        const name =
            escapeTelegramHtml(
                a.name
            );

        const running =
            a.current_state === 'running' ||
            a.status === 'running' ||
            a.current_state === 'online';

        const icon =
            running
                ? '🟢'
                : '🔴';

        text +=
            `${icon} <b>${name}</b>\n` +
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
            'HTML',

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
// LISTA DE USUARIOS TS
// ============================================================

async function showTsUsers(
    chatId,
    returnToChat = false
) {

    const users =
        await getTsUsers();

    let text =
        `<b>👥 USUARIOS CONECTADOS</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n`;

    if (
        users.length === 0
    ) {

        text +=
            `😴 No hay usuarios normales conectados.\n\n` +
            `💡 Los usuarios ServerQuery no aparecen en esta lista.`;

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

    if (returnToChat) {

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

                `🔐 <b>ACCESO AL PANEL</b>\n\n` +
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
// MENSAJES
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

                    `🔓 <b>Acceso de administrador concedido.</b>`,

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

                    `🔓 <b>Acceso de invitado concedido.</b>`,

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
        // HOME / PANEL
        // ====================================================

        if (
            data === 'menu_home'
        ) {

            await sendMainMenu(
                chatId
            );

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

                await bot.sendMessage(
                    chatId,
                    '🔴 No se pudo consultar Pterodactyl.'
                );
            }

            return;
        }

        // ====================================================
        // TEAMSPEAK
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

                    `💬 <b>Conectando al chat de TeamSpeak...</b>\n\n` +
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

                await bot.editMessageText(

                    `🔴 <b>No se pudo conectar al chat de TeamSpeak.</b>\n\n` +
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

                `💬 <b>Chat TeamSpeak cerrado.</b>`,

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
            );

            return;
        }

        // ====================================================
        // USUARIOS DESDE EL CHAT
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
        // ACCIONES SERVIDORES
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

            if (
                action === 'stop' ||
                action === 'restart'
            ) {

                const users =
                    await getTsUsers();

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
                            .slice(
                                0,
                                8
                            )
                            .map(
                                user =>
                                    `• ${escapeTelegramHtml(user.nickname)}`
                            )
                            .join('\n');

                    await bot.sendMessage(

                        chatId,

                        `⚠️ <b>HAY USUARIOS CONECTADOS</b>\n\n` +
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
                        `HTTP ${response.status}`
                    );
                }

                await bot.sendMessage(

                    chatId,

                    `✅ <b>${escapeTelegramHtml(action.toUpperCase())}</b> enviado correctamente.`,

                    {
                        parse_mode:
                            'HTML'
                    }
                );

            } catch (error) {

                console.error(
                    '[SERVER ACTION]',
                    error.message
                );

                await bot.sendMessage(
                    chatId,
                    '❌ Error al ejecutar la acción.'
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
                    throw new Error();
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
                await getTsUsers();

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
                        .slice(
                            0,
                            8
                        )
                        .map(
                            user =>
                                `• ${escapeTelegramHtml(user.nickname)}`
                        )
                        .join('\n');

                await bot.sendMessage(

                    chatId,

                    `⚠️ <b>USUARIOS CONECTADOS A TEAMSPEAK</b>\n\n` +
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
// REBOOT / POWEROFF
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

        /*
         * Puede ocurrir que la máquina se apague/reinicie
         * antes de que SSH pueda devolver una respuesta.
         */

        console.error(
            '[SYSTEM ACTION]',
            error.message
        );
    }
}

// ============================================================
// AVISO DE ARRANQUE
// ============================================================

async function sendStartupMessage() {

    const chatId =
        process.env.STARTUP_MESSAGE_CHAT_ID;

    if (!chatId) {
        return;
    }

    const hw =
        await getHardwareStats();

    const cpu =
        hw.cpu !== 'N/D'
            ? `🌡️ CPU: <b>${escapeTelegramHtml(hw.cpu)}°C</b>`
            : `🌡️ CPU: <b>N/D</b>`;

    const gpu =
        hw.gpu !== 'N/D'
            ? `🎮 GPU: <b>${escapeTelegramHtml(hw.gpu)}°C</b>`
            : `🎮 GPU: <b>N/D</b>`;

    const ram =
        hw.ramP !== 'N/D'
            ? `🧠 RAM: <b>${escapeTelegramHtml(hw.ramP)}%</b>`
            : `🧠 RAM: <b>N/D</b>`;

    const ping =
        hw.ping !== 'N/D'
            ? `📡 Ping: <b>${escapeTelegramHtml(hw.ping)} ms</b>`
            : `📡 Ping: <b>N/D</b>`;

    const text =
        `<b>✅ SISTEMA ONLINE</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `${cpu}\n` +
        `${gpu}\n` +
        `${ram}\n` +
        `${ping}\n\n` +
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
            '[STARTUP MESSAGE]',
            error.message
        );
    }
}

// ============================================================
// ERRORES TELEGRAM
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

// ============================================================
// ERRORES GLOBAL
// ============================================================

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
            '[STARTUP]',
            error.message
        );
    });
