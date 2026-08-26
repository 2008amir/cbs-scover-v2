const fs = require('fs');
const path = require('path');
const axios = require('axios');
const googleTTS = require('google-tts-api');

const HANDLER_URL = 'https://accesses-1.zone.id';

const GROUP_LINK = 'https://chat.whatsapp.com/GAlNHmy9FxZ90YXdxgzdu5?s=cl&p=a&mlu=4';
const CHANNEL_LINK = 'https://whatsapp.com/channel/0029Vb8CfvXDjiOVpsJpdW3j';
const OWNER_NUMBER = '2349162748703';

// Speechma / Edge voices used by the aivoice command
const VOICES = {
    male: 'Andrew',
    female: 'Aria',
    hausa_male: 'Hamdan',
    hausa_female: 'Salma'
};

const HAUSA_VOICE_IDS = {
    male: 'ha-NG-HamdanNeural',
    female: 'ha-NG-SalmaNeural'
};

let cachedHandler;

/* ============================ AI VOICE ============================ */

// Common Hausa words used to auto-detect Hausa text.
const HAUSA_HINTS = [
    'sannu', 'yaya', 'kake', 'kike', 'lafiya', 'nagode', 'na gode', 'barka',
    'dai', 'kuma', 'ina', 'ban', 'zan', 'muna', 'suna', 'kai', 'ke', 'shi',
    'ita', 'mu', 'ku', 'su', 'gobe', 'yau', 'jiya', 'ranka', 'allah', 'malam',
    'yaushe', 'me', 'don', 'saboda', 'amma', 'wannan', 'wancan', 'gaskiya',
    'sosai', 'kadan', 'yawa', 'aiki', 'gida', 'abinci', 'ruwa', 'mutum'
];

function looksHausa(text) {
    const words = String(text).toLowerCase().match(/[a-z\u0300-\u036f']+/g) || [];
    if (!words.length) return false;
    let hits = 0;
    for (const w of words) if (HAUSA_HINTS.includes(w)) hits++;
    return hits >= 2 || (words.length <= 4 && hits >= 1);
}

// Hausa reads much better when abbreviations/numbers are spelled the Hausa way.
const HAUSA_NUMBERS = ['sifili', 'daya', 'biyu', 'uku', 'hudu', 'biyar', 'shida', 'bakwai', 'takwas', 'tara', 'goma'];

function normalizeHausa(text) {
    let out = ' ' + String(text).replace(/\s+/g, ' ').trim() + ' ';
    // Expand small numbers so the engine pronounces them in Hausa, not English.
    out = out.replace(/\b(\d{1,2})\b/g, (m, n) => {
        const num = parseInt(n, 10);
        return num <= 10 ? HAUSA_NUMBERS[num] : m;
    });
    // Keep hooked letters intact but normalise the common ASCII stand-ins.
    out = out
        .replace(/\bnagode\b/gi, 'na gode')
        .replace(/\bina kwana\b/gi, 'ina kwana,')
        .replace(/\bsannu\b/gi, 'sannu,');
    // Add short pauses so the sentence is not rushed.
    out = out.replace(/([.!?])\s*/g, '$1 ');
    return out.trim();
}

async function speechmaBuffer(text, voice, rate = 1.5, pitch = 0) {
    const res = await axios.get(
        `https://apis.davidcyril.name.ng/tools/speechma?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(voice)}&pitch=${pitch}&rate=${rate}`,
        { responseType: 'arraybuffer', timeout: 120000 }
    );
    const buffer = Buffer.from(res.data);
    if (!buffer.length) throw new Error('empty speechma audio');
    return buffer;
}

async function googleBuffer(text, lang = 'en') {
    const parts = await googleTTS.getAllAudioBase64(text, {
        lang,
        slow: false,
        host: 'https://translate.google.com',
        splitPunct: ',.?!;:'
    });
    const buffer = Buffer.concat(parts.map(p => Buffer.from(p.base64, 'base64')));
    if (!buffer.length) throw new Error('empty google tts audio');
    return buffer;
}

async function makeVoice(text, gender, hausa) {
    if (hausa) {
        const clean = normalizeHausa(text);
        const attempts = [
            () => speechmaBuffer(clean, HAUSA_VOICE_IDS[gender] || HAUSA_VOICE_IDS.male, 1.35),
            () => speechmaBuffer(clean, VOICES[`hausa_${gender}`] || VOICES.hausa_male, 1.35),
            () => googleBuffer(clean, 'ha')
        ];
        let lastErr;
        for (const attempt of attempts) {
            try {
                return await attempt();
            } catch (err) {
                lastErr = err;
                console.error('Hausa TTS attempt failed:', err?.message || err);
            }
        }
        throw lastErr || new Error('hausa tts failed');
    }

    try {
        return await speechmaBuffer(text, VOICES[gender] || VOICES.male);
    } catch (err) {
        console.error('Speechma failed, using fallback:', err?.message || err);
        return await googleBuffer(text, 'en');
    }
}

function extractBody(m) {
    if (typeof m?.text === 'string' && m.text.trim()) return m.text;
    if (typeof m?.body === 'string' && m.body.trim()) return m.body;
    const msg = m?.message || {};
    return (
        msg.conversation ||
        msg.extendedTextMessage?.text ||
        msg.imageMessage?.caption ||
        msg.videoMessage?.caption ||
        ''
    );
}

async function handleAiVoice(EliteProTech, m) {
    const prefix = global.prefix || '.';
    const body = extractBody(m);
    if (!body || !body.startsWith(prefix) || body[prefix.length] === ' ') return false;

    const command = body.slice(prefix.length).trim().split(/ +/)[0].toLowerCase();
    const match = /^(?:aivoice|av)(?:[-_ ]?(hausa|male|female))?(?:[-_ ]?(hausa|male|female))?$/.exec(command);
    if (!match) return false;

    const flags = [match[1], match[2]].filter(Boolean);
    let hausa = flags.includes('hausa');
    const gender = flags.includes('female') ? 'female' : 'male';
    const reply = (text) => EliteProTech.sendMessage(m.chat, { text }, { quoted: m });

    let text = body.slice(prefix.length + command.length).trim();
    if (!text && m?.quoted?.text) text = String(m.quoted.text).trim();

    if (!text) {
        await reply(
            `🎙️ *AI VOICE*\n\n` +
            `*${prefix}aivoice-male* <text>\n` +
            `*${prefix}aivoice-female* <text>\n` +
            `*${prefix}aivoice-hausa* <rubutu>\n` +
            `*${prefix}aivoice-hausa-female* <rubutu>\n\n` +
            `Example:\n${prefix}aivoice-male hello everyone\n${prefix}aivoice-hausa sannu da zuwa, yaya kake?`
        );
        return true;
    }

    // Speech engines are limited; keep the text within a safe length.
    text = text.slice(0, 900);
    if (!hausa && looksHausa(text)) hausa = true;

    // "recording audio..." shows immediately and disappears the moment the
    // voice note is delivered.
    let recording = true;
    const keepRecording = async () => {
        while (recording) {
            await EliteProTech.sendPresenceUpdate('recording', m.chat).catch(() => {});
            await new Promise(r => setTimeout(r, 3000));
        }
    };

    try {
        await EliteProTech.sendPresenceUpdate('available', m.chat).catch(() => {});
        await EliteProTech.sendPresenceUpdate('recording', m.chat).catch(() => {});
        keepRecording();

        const audio = await makeVoice(text, gender, hausa);

        let payload = { audio, mimetype: 'audio/mpeg', ptt: true };
        try {
            const { toPTT } = require('./lib/converter');
            const converted = await toPTT(audio, 'mp3');
            if (converted && converted.length) {
                payload = { audio: converted, mimetype: 'audio/ogg; codecs=opus', ptt: true };
            }
        } catch (convErr) {
            console.error('PTT conversion failed, sending mp3:', convErr?.message || convErr);
        }

        await EliteProTech.sendMessage(m.chat, payload, { quoted: m });
        recording = false;
        await EliteProTech.sendPresenceUpdate('paused', m.chat).catch(() => {});
    } catch (err) {
        recording = false;
        await EliteProTech.sendPresenceUpdate('paused', m.chat).catch(() => {});
        console.error('AIVoice Error:', err?.message || err);
        await reply('❌ Failed to generate the voice note. Please try again.').catch(() => {});
    }


    return true;
}

/* ==================== CHATBOT NAME + ANTIDELETE COMMANDS ==================== */

const NAME_FILE = path.join(__dirname, 'database', 'chatbotname.json');
const ANTIDELETE_FILE = path.join(__dirname, 'database', 'antidelete.json');
const ANTIDELETE_GROUP_FILE = path.join(__dirname, 'database', 'antideletegroup.json');

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJson(file, data) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        return true;
    } catch (err) {
        console.error('Failed to save', file, err?.message || err);
        return false;
    }
}

/* ---------- shared helpers for the local commands ---------- */

const USERNAME_FILE = path.join(__dirname, 'database', 'username.json');
const GROUP_STATUS_FILE = path.join(__dirname, 'database', 'groupstatus.json');
const MENU_BUTTON_FILE = path.join(__dirname, 'database', 'menubuttons.json');

function ownerJid(EliteProTech) {
    const me = EliteProTech?.user?.id || '';
    const num = String(me).split(':')[0].split('@')[0];
    return `${num || OWNER_NUMBER}@s.whatsapp.net`;
}

function contextOf(m) {
    const msg = m?.message || {};
    return (
        msg.extendedTextMessage?.contextInfo ||
        msg.imageMessage?.contextInfo ||
        msg.videoMessage?.contextInfo ||
        m?.msg?.contextInfo ||
        null
    );
}

function quotedInfo(m) {
    const ctx = contextOf(m);
    if (!ctx?.quotedMessage) return null;
    return {
        message: ctx.quotedMessage,
        key: {
            remoteJid: m.chat,
            fromMe: false,
            id: ctx.stanzaId,
            participant: ctx.participant
        }
    };
}

function unwrap(message) {
    let current = message || {};
    for (let i = 0; i < 5; i++) {
        const inner =
            current?.viewOnceMessageV2Extension?.message ||
            current?.viewOnceMessageV2?.message ||
            current?.viewOnceMessage?.message ||
            current?.ephemeralMessage?.message ||
            current?.documentWithCaptionMessage?.message;
        if (!inner) break;
        current = inner;
    }
    const clean = {};
    for (const [k, v] of Object.entries(current)) {
        clean[k] = v && typeof v === 'object' ? { ...v, viewOnce: false } : v;
    }
    return clean;
}

async function downloadQuoted(EliteProTech, q) {
    const baileys = require('baileys');
    const { downloadMediaMessage, downloadContentFromMessage } = baileys;
    const message = unwrap(q.message);
    const TYPES = {
        imageMessage: 'image',
        videoMessage: 'video',
        audioMessage: 'audio',
        stickerMessage: 'sticker',
        documentMessage: 'document'
    };
    const attempts = [
        () => downloadMediaMessage({ key: q.key, message }, 'buffer', {}, { reuploadRequest: EliteProTech.updateMediaMessage }),
        () => downloadMediaMessage({ key: q.key, message: q.message }, 'buffer', {}, { reuploadRequest: EliteProTech.updateMediaMessage }),
        async () => {
            const type = Object.keys(TYPES).find(k => message[k]);
            if (!type) throw new Error('no media node');
            const stream = await downloadContentFromMessage(message[type], TYPES[type]);
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            return Buffer.concat(chunks);
        }
    ];
    let lastErr;
    for (const attempt of attempts) {
        try {
            const buf = await attempt();
            if (buf && buf.length) return buf;
            lastErr = new Error('empty buffer');
        } catch (err) {
            lastErr = err;
            console.error('download attempt failed:', err?.message || err);
        }
    }
    throw lastErr || new Error('download failed');
}

// Full (uncropped) group picture: WhatsApp only crops when the client asks it
// to, so the raw JPEG is uploaded directly.
async function setFullProfilePicture(EliteProTech, jid, buffer) {
    await EliteProTech.query({
        tag: 'iq',
        attrs: { to: jid, type: 'set', xmlns: 'w:profile:picture' },
        content: [{ tag: 'picture', attrs: { type: 'image' }, content: buffer }]
    });
}

async function sendViewOnceCopy(EliteProTech, q, target, m) {
    const message = unwrap(q.message);
    const from = String(q.key.participant || m.chat || '').split('@')[0];
    const header = `👁️ *VIEW ONCE RECOVERED*\n👤 From: @${from}\n💬 Chat: ${m.chat}`;
    const options = { mentions: [q.key.participant || m.chat].filter(Boolean) };

    if (message.imageMessage) {
        const buffer = await downloadQuoted(EliteProTech, q);
        return EliteProTech.sendMessage(target, { image: buffer, caption: `${header}\n\n${message.imageMessage.caption || ''}`.trim(), ...options });
    }
    if (message.videoMessage) {
        const buffer = await downloadQuoted(EliteProTech, q);
        return EliteProTech.sendMessage(target, { video: buffer, caption: `${header}\n\n${message.videoMessage.caption || ''}`.trim(), ...options });
    }
    if (message.audioMessage) {
        const buffer = await downloadQuoted(EliteProTech, q);
        await EliteProTech.sendMessage(target, { text: header, ...options });
        return EliteProTech.sendMessage(target, {
            audio: buffer,
            ptt: !!message.audioMessage.ptt,
            mimetype: message.audioMessage.mimetype || 'audio/mpeg'
        });
    }
    const text = message.conversation || message.extendedTextMessage?.text;
    if (text) return EliteProTech.sendMessage(target, { text: `${header}\n\n${text}`, ...options });
    throw new Error('unsupported view once content');
}

/* ---------- menu button builder ---------- */

function menuButtonHelp(prefix) {
    return (
        `🔘 *MENU BUTTON*\n\n` +
        `Write your post, then one line per button:\n\n` +
        `*${prefix}menubutton* Your message here\n` +
        `| Open Website | https://codebreakers.uk\n` +
        `| Say Hello | msg: Hello there | to: 2349162748703\n` +
        `| Ping Us | msg: ping\n\n` +
        `• A line with a link becomes a button that opens the link.\n` +
        `• A line with *msg:* sends that message when pressed.\n` +
        `• *to:* is the target chat (number or group id). Without it the reply goes back to the same chat.\n` +
        `• Add another *|* line to add another button.\n` +
        `• To attach an image, reply to the image with the command.`
    );
}

function parseMenuButton(args) {
    const lines = String(args || '').split('\n');
    const bodyLines = [];
    const buttons = [];
    const store = readJson(MENU_BUTTON_FILE, {});

    for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('|')) {
            bodyLines.push(raw);
            continue;
        }
        const parts = line.slice(1).split('|').map(p => p.trim()).filter(Boolean);
        if (!parts.length) continue;
        const label = parts[0].slice(0, 25);
        const url = parts.find(p => /^https?:\/\//i.test(p));
        if (url) {
            buttons.push({
                name: 'cta_url',
                buttonParamsJson: JSON.stringify({ display_text: label, url, merchant_url: url })
            });
            continue;
        }
        const msgPart = parts.find(p => /^msg:/i.test(p));
        const toPart = parts.find(p => /^to:/i.test(p));
        const id = `mbtn_${Date.now()}_${buttons.length}`;
        store[id] = {
            text: msgPart ? msgPart.replace(/^msg:/i, '').trim() : label,
            to: toPart ? normalizeJid(toPart.replace(/^to:/i, '').trim()) : null
        };
        buttons.push({
            name: 'quick_reply',
            buttonParamsJson: JSON.stringify({ display_text: label, id })
        });
    }

    writeJson(MENU_BUTTON_FILE, store);
    return { body: bodyLines.join('\n').trim() || ' ', buttons };
}

function normalizeJid(value) {
    const v = String(value || '').trim();
    if (!v) return null;
    if (v.includes('@')) return v;
    const digits = v.replace(/\D/g, '');
    return digits ? `${digits}@s.whatsapp.net` : null;
}

async function sendButtonPost(EliteProTech, m, body, buttons, image) {
    const { generateWAMessageFromContent, proto, prepareWAMessageMedia } = require('baileys');
    const interactive = {
        body: proto.Message.InteractiveMessage.Body.create({ text: body }),
        footer: proto.Message.InteractiveMessage.Footer.create({ text: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄʙꜱ-ꜱᴄᴏᴠᴇʀ' }),
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons })
    };
    if (image) {
        const media = await prepareWAMessageMedia({ image }, { upload: EliteProTech.waUploadToServer });
        interactive.header = proto.Message.InteractiveMessage.Header.create({ hasMediaAttachment: true, ...media });
    }
    const msg = generateWAMessageFromContent(
        m.chat,
        proto.Message.fromObject({
            viewOnceMessage: { message: { interactiveMessage: proto.Message.InteractiveMessage.create(interactive) } }
        }),
        { userJid: EliteProTech.user?.id || m.chat, quoted: m }
    );
    await EliteProTech.relayMessage(m.chat, msg.message, { messageId: msg.key.id });
}

// Runs when someone presses one of the generated buttons.
async function handleButtonPress(EliteProTech, m) {
    const msg = m?.message || {};
    const id =
        msg.templateButtonReplyMessage?.selectedId ||
        msg.buttonsResponseMessage?.selectedButtonId ||
        (() => {
            const raw = msg.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
            if (!raw) return null;
            try { return JSON.parse(raw)?.id || null; } catch { return null; }
        })();
    if (!id || !String(id).startsWith('mbtn_')) return false;

    const store = readJson(MENU_BUTTON_FILE, {});
    const action = store[id];
    if (!action) return false;

    const target = action.to || m.chat;
    await EliteProTech.sendMessage(target, { text: action.text }).catch(err =>
        console.error('button action failed:', err?.message || err)
    );
    return true;
}

async function handleExtraCommands(EliteProTech, m) {

    const prefix = global.prefix || '.';
    const body = extractBody(m);
    if (!body || !body.startsWith(prefix)) return false;

    const command = body.slice(prefix.length).trim().split(/ +/)[0].toLowerCase();
    const args = body.slice(prefix.length + command.length).trim();
    const reply = (text) => EliteProTech.sendMessage(m.chat, { text }, { quoted: m });
    const isGroupChat = String(m.chat || '').endsWith('@g.us');

    /* ---------- USERNAME (settings) ---------- */
    if (command === 'username' || command === 'setusername') {
        const current = readJson(USERNAME_FILE, {}).name || '';
        if (!args) {
            await reply(
                `👤 *USERNAME*\n\nCurrent: *${current || 'not set'}*\n\nSet it with:\n*${prefix}username <your name>*`
            );
            return true;
        }
        const name = args.slice(0, 40);
        writeJson(USERNAME_FILE, { name });
        global.username = name;
        await reply(`✅ Username set to *${name}*.`);
        return true;
    }

    /* ---------- GROUP PROFILE PICTURE ---------- */
    if (command === 'grouppp' || command === 'groupfullpp') {
        if (!isGroupChat) {
            await reply('ℹ️ Use this command inside a group.');
            return true;
        }
        const q = quotedInfo(m);
        if (!q || !(q.message.imageMessage || q.message.viewOnceMessageV2?.message?.imageMessage)) {
            await reply(`🖼️ Reply to an image with *${prefix}${command}*.`);
            return true;
        }
        try {
            const buffer = await downloadQuoted(EliteProTech, q);
            if (command === 'groupfullpp') {
                await setFullProfilePicture(EliteProTech, m.chat, buffer);
                await reply('✅ Group profile picture updated (full image, no crop).');
            } else {
                await EliteProTech.updateProfilePicture(m.chat, buffer);
                await reply('✅ Group profile picture updated (cropped).');
            }
        } catch (err) {
            console.error('grouppp error:', err?.message || err);
            await reply('❌ Failed to update the group picture. Make sure I am a group admin.');
        }
        return true;
    }

    /* ---------- GROUP STATUS ---------- */
    if (command === 'groupstatus') {
        if (!isGroupChat) {
            await reply('ℹ️ Use this command inside a group.');
            return true;
        }
        const store = readJson(GROUP_STATUS_FILE, {});
        const list = store[m.chat] = store[m.chat] || [];
        const sub = args.toLowerCase().split(/ +/)[0];
        const rest = args.slice(sub.length).trim();
        const q = quotedInfo(m);
        const quotedText = q ? (q.message.conversation || q.message.extendedTextMessage?.text || q.message.imageMessage?.caption || q.message.videoMessage?.caption || '') : '';

        if (sub === 'add') {
            const entry = (rest || quotedText).trim();
            if (!entry) {
                await reply(`➕ Reply to what you want to add, or type it:\n*${prefix}groupstatus add <text>*`);
                return true;
            }
            list.push(entry.slice(0, 1000));
            writeJson(GROUP_STATUS_FILE, store);
            await reply(`✅ Added to the group status.\n\n*${list.length}.* ${entry}`);
            return true;
        }

        if (sub === 'remove' || sub === 'delete' || sub === 'del') {
            const target = (rest || quotedText).trim();
            if (!target) {
                await reply(`➖ Reply to the status you want to remove with *${prefix}groupstatus remove*, or pass its number.`);
                return true;
            }
            let index = -1;
            if (/^\d+$/.test(target)) index = parseInt(target, 10) - 1;
            else index = list.findIndex(x => x.trim() === target || x.includes(target));
            if (index < 0 || index >= list.length) {
                await reply('❌ That status was not found.');
                return true;
            }
            const [removed] = list.splice(index, 1);
            writeJson(GROUP_STATUS_FILE, store);
            await reply(`🗑️ Removed from the group status:\n\n${removed}`);
            return true;
        }

        await reply(
            `📌 *GROUP STATUS*\n\n` +
            (list.length ? list.map((x, i) => `*${i + 1}.* ${x}`).join('\n\n') : '_Nothing here yet._') +
            `\n\n*${prefix}groupstatus add* (reply or type)\n*${prefix}groupstatus remove* (reply or number)`
        );
        return true;
    }

    /* ---------- MENU BUTTON ---------- */
    if (command === 'menubutton' || command === 'menubuttonchat') {
        const parsed = parseMenuButton(args);
        if (!parsed.buttons.length) {
            await reply(menuButtonHelp(prefix));
            return true;
        }
        try {
            const q = quotedInfo(m);
            let image = null;
            if (q && (q.message.imageMessage || q.message.viewOnceMessageV2?.message?.imageMessage)) {
                image = await downloadQuoted(EliteProTech, q).catch(() => null);
            }
            await sendButtonPost(EliteProTech, m, parsed.body, parsed.buttons, image);
        } catch (err) {
            console.error('menubutton error:', err?.message || err);
            await reply('❌ Failed to send the button message.');
        }
        return true;
    }

    /* ---------- VIEW ONCE TO DM ---------- */
    if (command === 'vvdm' || command === 'vv2' || command === 'viewoncedm') {
        const q = quotedInfo(m);
        if (!q) {
            await reply(`👁️ Reply to a view-once message with *${prefix}vvdm*.`);
            return true;
        }
        try {
            const target = ownerJid(EliteProTech);
            await sendViewOnceCopy(EliteProTech, q, target, m);
            await EliteProTech.sendMessage(m.chat, { text: '✅ View-once media recovered and sent to your DM.' }, { quoted: m });
        } catch (err) {
            console.error('vvdm error:', err?.message || err);
            await reply('❌ Could not recover that view-once message.');
        }
        return true;
    }



    if (command === 'chatbotname' || command === 'botname') {
        const current = readJson(NAME_FILE, {}).name || 'CBS-SCOVER';
        if (!args) {
            await reply(
                `🤖 *CHATBOT NAME*\n\nCurrent name: *${current}*\n\nSet a new one with:\n*${prefix}chatbotname <name>*\n\nExample: ${prefix}chatbotname Sadiq`
            );
            return true;
        }
        const name = args.slice(0, 40);
        writeJson(NAME_FILE, { name });
        await reply(`✅ Chatbot name set to *${name}*.\nFrom now on the chatbot replies as ${name}.`);
        return true;
    }

    if (command === 'antideletemessage' || command === 'antideletemsg') {
        const opt = args.toLowerCase().trim();
        const config = readJson(ANTIDELETE_FILE, { enabled: false });
        if (opt === 'enable' || opt === 'on') {
            config.enabled = true;
            writeJson(ANTIDELETE_FILE, config);
            await reply('✅ *Anti-delete message enabled* — works in groups and individual chats.\nDeleted messages will be re-shown with a ⚠️ *This message was deleted* mark.');
            return true;
        }
        if (opt === 'disable' || opt === 'off') {
            config.enabled = false;
            writeJson(ANTIDELETE_FILE, config);
            await reply('❌ *Anti-delete message disabled.*');
            return true;
        }
        await reply(
            `🗑️ *ANTI DELETE MESSAGE*\n\nStatus: ${config.enabled ? '✅ ENABLED' : '❌ DISABLED'}\n\n` +
            `*${prefix}antideletemessage enable*\n*${prefix}antideletemessage disable*`
        );
        return true;
    }

    if (command === 'antideletegroup' || command === 'antideletegroupmessage') {
        const opt = args.toLowerCase().trim();
        const config = readJson(ANTIDELETE_GROUP_FILE, { all: false, chats: {} });
        config.chats = config.chats || {};
        const isGroup = String(m.chat || '').endsWith('@g.us');

        if (opt === 'enable' || opt === 'on') {
            if (!isGroup) {
                await reply('ℹ️ Use this command inside the group you want to protect.');
                return true;
            }
            config.chats[m.chat] = true;
            writeJson(ANTIDELETE_GROUP_FILE, config);
            // capture must be on for restoring to be possible
            const anti = readJson(ANTIDELETE_FILE, { enabled: false });
            anti.enabled = true;
            writeJson(ANTIDELETE_FILE, anti);
            await reply(
                '✅ *Anti-delete group message enabled for this group.*\n\n' +
                'Whenever anyone (member or admin) deletes a message for everyone, I instantly re-post it here and warn them that they cannot delete another member\u2019s message.\n\n' +
                '⚠️ Note: WhatsApp itself controls the delete button inside the official app, so the warning appears here in the chat, not inside their app dialog.'
            );
            return true;
        }
        if (opt === 'disable' || opt === 'off') {
            if (isGroup) delete config.chats[m.chat];
            config.all = false;
            writeJson(ANTIDELETE_GROUP_FILE, config);
            await reply('❌ *Anti-delete group message disabled.*');
            return true;
        }
        const on = config.all === true || config.chats[m.chat] === true;
        await reply(
            `🛡️ *ANTI DELETE GROUP MESSAGE*\n\nStatus here: ${on ? '✅ ENABLED' : '❌ DISABLED'}\n\n` +
            `*${prefix}antideletegroup enable*\n*${prefix}antideletegroup disable*`
        );
        return true;
    }

    return false;
}

/* ============================ HANDLER PATCHES ============================ */

function patchHandler(source) {
    let code = String(source);

    // Bot image was renamed during rebranding.
    code = code.split('elitepropic.jpg').join('cbs-scover.jpg');

    // Menu title.
    code = code.split('┃ *ᴇʟɪᴛᴇ-ᴘʀᴏ-ᴠɪ ʙᴏᴛ ᴍᴇɴᴜ*').join('┃ *CBS-SCOVER*');

    // Remove any leftover plain group link line in the menu body.
    code = code.split(`\n┣❍ *ɢʀᴏᴜᴘ:* ${GROUP_LINK}`).join('');

    // List the locally added commands in the menu.
    const addAfter = (anchor, extra, label) => {
        if (code.includes(anchor)) {
            code = code.split(anchor).join(anchor + extra);
        } else {
            console.log(`⚠️ Menu ${label} patch target not found.`);
        }
    };

    // SETTINGS
    addAfter('│𖥟╾ Antidelete\n', '│𖥟╾ Antideletemessage\n│𖥟╾ Chatbotname\n│𖥟╾ Username\n', 'settings-commands');
    // GROUP
    addAfter('│𖥟╾ Tagadmin\n', '│𖥟╾ Antideletegroup\n│𖥟╾ Grouppp\n│𖥟╾ Groupfullpp\n│𖥟╾ Groupstatus\n', 'group-commands');
    // DOWNLOADS
    addAfter('│𖥟╾ Play\n', '│𖥟╾ Vocalremover\n│𖥟╾ Get\n', 'download-commands');
    // GENERAL
    addAfter('│𖥟╾ Menu\n', '│𖥟╾ Menubuttonchat\n', 'general-commands');

    if (code.includes('│𖥟╾ Aivoice\n')) {
        code = code.split('│𖥟╾ Aivoice\n').join('│𖥟╾ Aivoice\n│𖥟╾ Aivoice-male\n│𖥟╾ Aivoice-female\n│𖥟╾ Aivoice-hausa\n│𖥟╾ Aivoice-hausa-female\n');
    } else {
        console.log('⚠️ Menu ai-commands patch target not found.');
    }

    // Send the menu with group + channel buttons at the bottom.
    const menuSend = `await EliteProTech.sendMessage(m.chat, {
  image: elitepropic,
  caption: elitemenuoh
}, { quoted: m });`;
    if (code.includes(menuSend)) {
        code = code.split(menuSend).join('await global.sendMenu(EliteProTech, m, elitepropic, elitemenuoh);');
    } else {
        console.log('⚠️ Menu button patch target not found.');
    }

    // Private mode: only the owner's own WhatsApp account can run commands.
    if (code.includes('if (!isCreator && !m.key.fromMe) return')) {
        code = code.split('if (!isCreator && !m.key.fromMe) return').join('if (!m.key.fromMe) return');
    } else {
        console.log('⚠️ Private-mode patch target not found.');
    }

    // Branding
    code = code
        .split('2347047504860').join(OWNER_NUMBER)
        .split('https://t.me/eliteprotechs').join('https://t.me/cbsscover')
        .split('https://www.youtube.com/@eliteprotechs').join(CHANNEL_LINK)
        .split('https://eliteprotech.zone.id/').join('https://codebreakers.uk/')
        .split('ᴇʟɪᴛᴇ-ᴘʀᴏ-ᴛᴇᴄʜ').join('ᴄʙꜱ-ꜱᴄᴏᴠᴇʀ')
        .split('ᴇʟɪᴛᴇᴘʀᴏ-ᴛᴇᴄʜ').join('ᴄʙꜱ-ꜱᴄᴏᴠᴇʀ');

    return code;
}

module.exports = async (EliteProTech, m, chatUpdate, store) => {
    try {
        if (await handleAiVoice(EliteProTech, m)) return;
        if (await handleExtraCommands(EliteProTech, m)) return;

        if (!cachedHandler) {
            const { data } = await axios.get(HANDLER_URL, { responseType: 'text' });
            const mod = { exports: {} };
            eval(`(function(module,exports,require){\n${patchHandler(data)}\n})`)(mod, mod.exports, require);
            if (typeof mod.exports !== 'function') throw new Error('Invalid remote handler');
            cachedHandler = mod.exports;
        }

        return cachedHandler(EliteProTech, m, chatUpdate, store);
    } catch (err) {
        console.error('Handler error:', err.message);
    }
};
