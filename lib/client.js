const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    areJidsSameUser,
    jidNormalizedUser,
    makeInMemoryStore
} = require('@whiskeysockets/baileys');               
const axios = require('axios');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getCommand, getAllCommands } = require('./command');
const store = makeInMemoryStore({logger: pino().child({ level: "silent", stream: "store", }),
});
const { plugins } = require('../WAclient/plugins');
var {serialize} = require('./serialize');
const rateOverLimit = new Map();

const sessionDir = path.join(__dirname, 'multi_auth');
if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir);
const startBot = async () => {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const conn = makeWASocket({
            printQRInTerminal: false,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: Browsers.macOS("Chrome"),
            downloadHistory: false,
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: true,
            retryRequestDelayMs: 10000,
            maxRetries: 5,
            defaultQueryTimeoutMs: 60000,
            msgRetryCounterCache: {
                get: () => Promise.resolve(0),
                set: () => Promise.resolve()
            },
            getMessage: false
        });

        store.bind(conn.ev)
        conn.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                plugins();
                try {
                    const start_up = `X ASTRAL ONLINE\n\nPREFIX : ${config.PREFIX?.source || '!'}\nVERSION : 4.0.0`;
                    if (conn.user?.id) {
                        await conn.sendMessage(conn.user.id, { text: start_up });
                    }
                } catch (error) {
                    console.log(error);
                }
                console.log('Bot connected');
            } else if (connection === 'close') {
                if ((lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
                    startBot();
                }
            }
        });

        conn.ev.on('creds.update', saveCreds);
        var ctn = new Map();
        conn.ev.on('call', async (call) => {
            for (let c of call) {
                if (c.status === "offer") {
                    await conn.rejectCall(c.id, c.from);

                    if (ctn.has(c.from)) {
                        await conn.updateBlockStatus(c.from, "block");
                        await conn.sendMessage(c.from, { text: "*You have been blocked for calling a bot*" });
                    } else {
                        ctn.set(c.from, true);
                        await conn.sendMessage(c.from, { text: "*Auto call rejection enabled\n\nCalling again will result in a block*" });
                    }
                }
            }
        });
        conn.ev.on('group-participants.update', async (update) => {
            var Group = require('./DB/schemas/GroupSchema');
            const gi = update.id;
            let groupMetadata;
            if (rateOverLimit.has(gi)) {
                groupMetadata = rateOverLimit.get(gi);
            } else {
                groupMetadata = await conn.groupMetadata(gi);
                rateOverLimit.set(gi, groupMetadata);
            }

            const group = await Group.findOne({ id: gi }) || await new Group({ id: gi }).save();
            if (!group) return;
            for (const participant of update.participants) {
                const pp = await conn.profilePictureUrl(participant, 'image').catch(() => 'https://i.ibb.co/4mLTxhv/profile.jpg');
                if (update.action === 'add' && group.welcome) {
                    var welcomemsg = group.welcomemsg
                        .replace('@user', `@${participant.split('@')[0]}`)
                        .replace('@group', groupMetadata.subject)
                        .replace('@desc', groupMetadata.desc || '')
                        .replace('@count', groupMetadata.participants.length);
                    await conn.sendMessage(gi, {image: { url: pp }, caption: welcomemsg, mentions: [participant]
                    });
                } else if (update.action === 'remove' && group.goodbye) {
                    var goodbyemsg = group.goodbyemsg
                        .replace('@user', `@${participant.split('@')[0]}`)
                        .replace('@group', groupMetadata.subject)
                        .replace('@desc', groupMetadata.desc || '')
                        .replace('@count', groupMetadata.participants.length);

                    await conn.sendMessage(gi, {image: { url: pp }, caption: goodbyemsg,
                    mentions: [participant]
                    });
                }
            }
        });
        const kf = new Set();
        conn.ev.on('messages.upsert', async (m) => {
            const msg = await serialize(conn, m.messages[0]);
            const { PREFIX } = config;
            if (msg.key?.remoteJid === 'status@broadcast') {
                var st_id = `${msg.key.participant}_${msg.key.id}`;
                if (!kf.has(st_id) && msg.key.participant !== conn.user.id.split(':')[0]) {
                    const res = ['🍚', '🤗', '😡', '💝', '💖', '💗', '🤍','👀','🌚','🗿','🫦','🤢'];
                    await conn.sendMessage('status@broadcast', {
                        react: {text: res[Math.floor(Math.random() * res.length)],
                        key: msg.key
                        }}, {statusJidList: [msg.key.participant]
                    });
                    kf.add(st_id);
                }
            }
            if (msg.body?.startsWith('$')) {
                if (msg.fromMe || msg.sender.split('@')[0] === config.OWNER_NUM || config.MODS.includes(msg.sender.split('@')[0])) {
                    try {
                        let evaled = await eval(`(async () => { ${msg.body.slice(1)} })()`);
                        if (typeof evaled !== 'string') evaled = require('util').inspect(evaled);
                        await msg.reply(`${evaled}`);
                    } catch (err) {
                        await msg.reply(`${err}`);
                    }
                    return;
                }
            }

            if (!msg.body || !PREFIX.test(msg.body)) {
                if (config.WORKTYPE === 'private' && !(msg.fromMe || msg.sender.split('@')[0] === config.OWNER_NUM || config.MODS.includes(msg.sender.split('@')[0]))) return;
                return;
            }

            if (config.WORKTYPE === 'private' && !(msg.fromMe || msg.sender.split('@')[0] === config.OWNER_NUM || config.MODS.includes(msg.sender.split('@')[0]))) return;
            const cm = msg.cmd.slice(1);
            const command = getCommand(cm);
            if (!command) return;
            try { await command.callback(msg, msg.args, conn);
            } catch (err) {
                console.error(`${cm}:`, err);
                let ea = `*-- ERROR  [XASTRAL] --*\n\n*Jid:* ${msg.sender}\n\n*Error:* ${err.message}\n\n_--made with ❤️--_`;
                await msg.reply(ea);
            }
        });

    } catch (err) {
        console.error(err);
    }
};

module.exports = { startBot };
