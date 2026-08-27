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
const CHATBOT_FILE = path.join(__dirname, 'database', 'chatbot.json');

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

// Image the command should work on: a replied image, or the image the command
// was sent as a caption of.
function imageSource(m) {
    const q = quotedInfo(m);
    if (q && unwrap(q.message).imageMessage) return q;
    const own = unwrap(m.message || {});
    if (own.imageMessage) return { message: m.message, key: m.key };
    return null;
}

async function cropSquare(buffer) {
    const Jimp = require('jimp');
    const img = await Jimp.read(buffer);
    const side = Math.min(img.getWidth(), img.getHeight());
    return img
        .crop((img.getWidth() - side) / 2, (img.getHeight() - side) / 2, side, side)
        .resize(640, 640)
        .quality(90)
        .getBufferAsync(Jimp.MIME_JPEG);
}

// WhatsApp always displays a square profile picture, so "full, no crop" means
// fitting the whole image inside a square canvas instead of cutting it.
async function padToSquare(buffer) {
    const Jimp = require('jimp');
    const img = await Jimp.read(buffer);
    const side = Math.max(img.getWidth(), img.getHeight());
    const canvas = new Jimp(side, side, 0x000000ff);
    const fitted = img.clone().contain(side, side);
    canvas.composite(fitted, 0, 0);
    return canvas.resize(640, 640).quality(90).getBufferAsync(Jimp.MIME_JPEG);
}

async function groupAudience(EliteProTech, jid) {
    try {
        const meta = await EliteProTech.groupMetadata(jid);
        return (meta?.participants || []).map(p => p.id || p.jid).filter(Boolean);
    } catch {
        return [];
    }
}

// Builds a real WhatsApp status payload from a replied message (text, image,
// video or audio) or from typed text.
async function buildStatusContent(EliteProTech, m, typedText) {
    const q = quotedInfo(m);
    const quoted = q ? unwrap(q.message) : {};

    if (q && (quoted.imageMessage || quoted.videoMessage || quoted.audioMessage)) {
        const buffer = await downloadQuoted(EliteProTech, q);
        if (quoted.imageMessage) {
            return { image: buffer, caption: typedText || quoted.imageMessage.caption || '' };
        }
        if (quoted.videoMessage) {
            return { video: buffer, caption: typedText || quoted.videoMessage.caption || '' };
        }
        return {
            audio: buffer,
            mimetype: quoted.audioMessage.mimetype || 'audio/mp4',
            ptt: !!quoted.audioMessage.ptt
        };
    }

    const own = unwrap(m.message || {});
    if (own.imageMessage || own.videoMessage) {
        const buffer = await downloadQuoted(EliteProTech, { message: m.message, key: m.key });
        return own.imageMessage
            ? { image: buffer, caption: typedText }
            : { video: buffer, caption: typedText };
    }

    const text =
        typedText ||
        quoted.conversation ||
        quoted.extendedTextMessage?.text ||
        '';
    return text.trim() ? { text: text.trim() } : null;
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

/* ============================ MENU BUTTON ============================
   Stateless: every invocation parses its own message from scratch. No
   "first run" flags, no module-level parser state.
   ==================================================================== */

function menuButtonHelp(prefix) {
    const example =
        `${prefix}menubutton Your message here\n` +
        `| Open Website | https://codebreakers.uk\n` +
        `| Say Hello | msg: Hello there | to: 2349162748703\n` +
        `| Ping Us | msg: ping`;
    return (
        `🔘 *MENU BUTTON*\n\n` +
        `Write your post, then one line per button: to add image on it reply to the image\n\n` +
        `${example}\n\n` +
        `• A line with a link becomes a button that opens the link.\n` +
        `• A line with *msg:* sends that message when pressed.\n` +
        `• *to:* is the target chat (number or group id). Without it the reply goes back to the same chat.\n` +
        `• Add another *|* line to add another button.\n` +
        `• To attach an image, reply to the image with the command.\n\n` +
        `${example}`
    );
}

function normalizeJid(value) {
    const v = String(value || '').trim();
    if (!v) return null;
    if (v.includes('@')) {
        const [num, server] = v.split('@');
        if (!/^[0-9-]{5,32}$/.test(num)) return null;
        return `${num}@${server || 's.whatsapp.net'}`;
    }
    if (/^[0-9-]{10,}$/.test(v) && v.includes('-')) return `${v}@g.us`;   // group id form
    const digits = v.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 16) return null;
    return `${digits}@s.whatsapp.net`;
}

function isHttpUrl(value) {
    if (!/^https?:\/\//i.test(value)) return false;
    try {
        const u = new URL(value);
        return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname && u.hostname.includes('.');
    } catch {
        return false;
    }
}

function formatError(lineNo, line, reason, expected) {
    return (
        `❌ *Menu formatting error*\n\n` +
        `Invalid line ${lineNo}:\n${line}\n\n` +
        `Reason:\n${reason}\n\n` +
        `Expected:\n${expected}\n\n` +
        `Please correct this line and try again.`
    );
}

const SUPPORTED =
    `Supported values:\n` +
    `• https://example.com\n` +
    `• msg: Your message\n` +
    `• msg: Your message | to: 234xxxxxxxxxx`;

/**
 * Parses the body of a .menubutton command, line by line.
 * Returns { ok, error, title, items } — items describe the actions and are
 * only persisted by the caller once the whole message validated.
 */
function parseMenuButton(args) {
    const lines = String(args || '').split('\n');
    const titleLines = [];
    const items = [];
    let seenRow = false;

    for (let i = 0; i < lines.length; i++) {
        const lineNo = i + 1;            // line 1 is the ".menubutton ..." line
        const raw = lines[i];
        const line = raw.trim();

        if (!line) {
            if (!seenRow) titleLines.push(raw);
            continue;
        }

        if (!line.includes('|')) {
            if (seenRow) {
                return {
                    ok: false,
                    error: formatError(
                        lineNo, line,
                        'This line is not a menu row. Every line after the first button must start with "|".',
                        '| Label | value'
                    )
                };
            }
            titleLines.push(raw);
            continue;
        }

        if (!line.startsWith('|')) {
            return {
                ok: false,
                error: formatError(lineNo, line, 'A menu row must start with "|".', '| Label | value')
            };
        }

        seenRow = true;
        const parts = line.slice(1).split('|').map(p => p.trim());
        const label = (parts.shift() || '').trim();
        if (!label) {
            return {
                ok: false,
                error: formatError(lineNo, line, 'The menu label is missing.', '| Label | value')
            };
        }

        const values = parts.filter(p => p.length);
        if (!values.length) {
            return {
                ok: false,
                error: formatError(lineNo, line, 'The menu value is missing.', '| Label | value')
            };
        }

        const url = values.find(v => /^https?:\/\//i.test(v));
        if (url) {
            if (!isHttpUrl(url)) {
                return {
                    ok: false,
                    error: formatError(lineNo, line, `"${url}" is not a valid HTTP/HTTPS URL.`, '| Label | https://example.com')
                };
            }
            items.push({ type: 'url', label: label.slice(0, 25), url });
            continue;
        }

        const msgPart = values.find(v => /^msg\s*:/i.test(v));
        if (!msgPart) {
            const looksLikeUrl = values.some(v => /^(www\.|[a-z0-9-]+\.[a-z]{2,})/i.test(v));
            return {
                ok: false,
                error: formatError(
                    lineNo, line,
                    looksLikeUrl
                        ? 'A website value must be a full HTTP/HTTPS URL.'
                        : 'Unsupported menu action.',
                    SUPPORTED
                )
            };
        }

        const text = msgPart.replace(/^msg\s*:/i, '').trim();
        if (!text) {
            return {
                ok: false,
                error: formatError(lineNo, line, 'The msg: value has no message text.', '| Label | msg: Your message')
            };
        }

        let to = null;
        const toPart = values.find(v => /^to\s*:/i.test(v));
        if (toPart) {
            const rawTo = toPart.replace(/^to\s*:/i, '').trim();
            if (!rawTo) {
                return {
                    ok: false,
                    error: formatError(lineNo, line, 'The to: recipient is missing.', '| Label | msg: Your message | to: 234xxxxxxxxxx')
                };
            }
            to = normalizeJid(rawTo);
            if (!to) {
                return {
                    ok: false,
                    error: formatError(lineNo, line, `"${rawTo}" is not a valid phone number or group id.`, '| Label | msg: Your message | to: 234xxxxxxxxxx')
                };
            }
        }

        items.push({ type: 'msg', label: label.slice(0, 25), text, to });
    }

    if (!items.length) {
        return {
            ok: false,
            error:
                `❌ *Menu formatting error*\n\nNo menu row found.\n\n` +
                `Add at least one line:\n| Label | value\n\n${SUPPORTED}`
        };
    }

    return { ok: true, title: titleLines.join('\n').trim(), items };
}

// Persist quick-reply actions and build the native flow buttons.
function buildButtons(items) {
    const store = readJson(MENU_BUTTON_FILE, {});
    // keep the store small: drop entries older than 30 days
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const [k, v] of Object.entries(store)) {
        if (v && typeof v === 'object' && v.at && v.at < cutoff) delete store[k];
    }

    const buttons = [];
    const plain = [];
    items.forEach((item, i) => {
        if (item.type === 'url') {
            buttons.push({
                name: 'cta_url',
                buttonParamsJson: JSON.stringify({
                    display_text: item.label,
                    url: item.url,
                    merchant_url: item.url
                })
            });
            plain.push(`🔗 ${item.label} → ${item.url}`);
            return;
        }
        const id = `mbtn_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 7)}`;
        store[id] = { text: item.text, to: item.to, at: Date.now() };
        buttons.push({
            name: 'quick_reply',
            buttonParamsJson: JSON.stringify({ display_text: item.label, id })
        });
        plain.push(`💬 ${item.label} → ${item.text}${item.to ? ` (to ${item.to.split('@')[0]})` : ''}`);
    });

    writeJson(MENU_BUTTON_FILE, store);
    return { buttons, plain };
}

/**
 * Sends a native-flow interactive message. WhatsApp only renders native flow
 * buttons when the interactive message carries messageContextInfo and is
 * wrapped in viewOnceMessage — without it relayMessage "succeeds" but the
 * client shows nothing at all. That was the reason menus never appeared.
 */
async function sendNativeFlow(EliteProTech, jid, { body, footer, buttons, image, quoted }) {
    const { generateWAMessageFromContent, proto, prepareWAMessageMedia } = require('baileys');

    const interactive = {
        body: proto.Message.InteractiveMessage.Body.create({ text: body || ' ' }),
        footer: proto.Message.InteractiveMessage.Footer.create({ text: footer || '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄʙꜱ-ꜱᴄᴏᴠᴇʀ' }),
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
            buttons,
            messageParamsJson: ''
        })
    };

    if (image) {
        const media = await prepareWAMessageMedia(
            { image: typeof image === 'string' ? { url: image } : image },
            { upload: EliteProTech.waUploadToServer }
        );
        interactive.header = proto.Message.InteractiveMessage.Header.create({
            hasMediaAttachment: true,
            ...media
        });
    }

    const inner = {
        messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2
        },
        interactiveMessage: proto.Message.InteractiveMessage.create(interactive)
    };

    const msg = generateWAMessageFromContent(
        jid,
        proto.Message.fromObject({ viewOnceMessage: { message: inner } }),
        { userJid: EliteProTech.user?.id || jid, quoted }
    );
    await EliteProTech.relayMessage(jid, msg.message, { messageId: msg.key.id });
    return msg;
}
global.sendNativeFlow = sendNativeFlow;

async function sendButtonPost(EliteProTech, m, body, buttons, image, plain) {
    // The post itself always goes out as a normal message first, so the user
    // never ends up with nothing when the client drops interactive content.
    const listed = (plain && plain.length) ? `\n\n${plain.join('\n')}` : '';
    try {
        if (image) {
            await EliteProTech.sendMessage(m.chat, { image, caption: body }, { quoted: m });
        } else {
            await EliteProTech.sendMessage(m.chat, { text: body }, { quoted: m });
        }
    } catch (err) {
        console.error('[menubutton] post send failed:', err?.message || err);
    }

    try {
        await sendNativeFlow(EliteProTech, m.chat, {
            body: '🔘 Tap an option below',
            buttons,
            quoted: m
        });
        console.log(`[menubutton] interactive sent to ${m.chat} (${buttons.length} buttons)`);
        return 'interactive';
    } catch (err) {
        console.error('[menubutton] interactive send failed:', err?.message || err);
    }

    await EliteProTech.sendMessage(m.chat, { text: `🔘 *OPTIONS*${listed}` }, { quoted: m })
        .catch(e => console.error('[menubutton] text fallback failed:', e?.message || e));
    return 'text';
}


// Runs when someone presses one of the generated buttons.
async function handleButtonPress(EliteProTech, m) {
    const msg = m?.message || {};
    let id =
        msg.templateButtonReplyMessage?.selectedId ||
        msg.buttonsResponseMessage?.selectedButtonId ||
        msg.listResponseMessage?.singleSelectReply?.selectedRowId ||
        null;

    if (!id) {
        const raw =
            msg.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
            msg.interactiveResponseMessage?.body?.text ||
            null;
        if (raw) {
            try { id = JSON.parse(raw)?.id || null; } catch { id = null; }
        }
    }
    if (!id || !String(id).startsWith('mbtn_')) return false;

    const store = readJson(MENU_BUTTON_FILE, {});
    const action = store[id];
    if (!action) {
        console.log(`[menubutton] pressed unknown action ${id}`);
        return false;
    }

    const target = action.to && normalizeJid(action.to) ? normalizeJid(action.to) : m.chat;
    try {
        await EliteProTech.sendMessage(target, { text: action.text });
        console.log(`[menubutton] action ${id} delivered to ${target}`);
    } catch (err) {
        console.error('[menubutton] action failed:', err?.message || err);
        await EliteProTech.sendMessage(m.chat, { text: `❌ Could not deliver that button message.` }).catch(() => {});
    }
    return true;
}


async function handleExtraCommands(EliteProTech, m) {

    const prefix = global.prefix || '.';
    const body = extractBody(m);
    if (!body || !body.startsWith(prefix)) return false;

    // Split on any whitespace (including newlines) so multi-line commands like
    // ".menubutton ...\n| Label | value" are recognised.
    const rest = body.slice(prefix.length).replace(/^\s+/, '');
    const command = (rest.split(/\s+/)[0] || '').toLowerCase();
    const args = rest.slice(command.length).replace(/^[^\S\n]+/, '').replace(/^\n/, '').trim();

    const reply = (text) => EliteProTech.sendMessage(m.chat, { text }, { quoted: m });
    const isGroupChat = String(m.chat || '').endsWith('@g.us');

    /* ---------- PROMOTE (no admin check on our side) ---------- */
    if (command === 'promote') {
        if (!isGroupChat) {
            await reply('ℹ️ Use this command inside a group.');
            return true;
        }
        const mentioned = m.msg?.contextInfo?.mentionedJid || m.mentionedJid || [];
        const quotedSender = m.msg?.contextInfo?.participant;
        const numeric = (args.match(/[0-9]{7,16}/g) || []).map(n => `${n}@s.whatsapp.net`);
        const targets = [...new Set([...mentioned, ...numeric, ...(quotedSender ? [quotedSender] : [])])];
        if (!targets.length) {
            await reply(`👑 Tag, reply to, or type the number of the person:\n*${prefix}promote @user*`);
            return true;
        }
        const ok = [];
        const failed = [];
        for (const jid of targets) {
            let done = false;
            for (let attempt = 0; attempt < 3 && !done; attempt++) {
                try {
                    await EliteProTech.groupParticipantsUpdate(m.chat, [jid], 'promote');
                    done = true;
                } catch (err) {
                    if (attempt === 2) console.error('promote error:', err?.message || err);
                    await new Promise(r => setTimeout(r, 700));
                }
            }
            (done ? ok : failed).push(jid);
        }
        let text = '';
        if (ok.length) text += `👑 Promoted to admin:\n${ok.map(j => '@' + j.split('@')[0]).join('\n')}\n`;
        if (failed.length) {
            text += `\n❌ WhatsApp refused the promotion for:\n${failed.map(j => '@' + j.split('@')[0]).join('\n')}\n\n` +
                `Promotion is enforced by WhatsApp's servers — the bot itself must be a group admin. No client-side bypass exists.`;
        }
        await EliteProTech.sendMessage(m.chat, { text: text.trim(), mentions: targets }, { quoted: m });
        return true;
    }

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
    if (command === 'grouppp' || command === 'groupfullpp' || command === 'setgrouppp') {
        if (!isGroupChat) {
            await reply('ℹ️ Use this command inside a group.');
            return true;
        }
        const source = imageSource(m);
        if (!source) {
            await reply(`🖼️ Reply to an image (or send the image with the caption) using *${prefix}${command}*.`);
            return true;
        }
        try {
            const raw = await downloadQuoted(EliteProTech, source);
            if (command === 'groupfullpp') {
                const padded = await padToSquare(raw);
                await EliteProTech.updateProfilePicture(m.chat, padded);
                await reply('✅ Group profile picture updated — full image, nothing cropped out.');
            } else {
                const cropped = await cropSquare(raw);
                await EliteProTech.updateProfilePicture(m.chat, cropped);
                await reply('✅ Group profile picture updated (cropped).');
            }
        } catch (err) {
            console.error('grouppp error:', err?.message || err);
            await reply(`❌ Could not set the group picture.\n${err?.message || err}\n\nI must be a group admin to change it.`);
        }
        return true;
    }

    /* ---------- GROUP STATUS (real WhatsApp status) ---------- */
    if (command === 'groupstatus' || command === 'addstatus' || command === 'mystatus') {
        const groupMode = command === 'groupstatus';
        if (groupMode && !isGroupChat) {
            await reply('ℹ️ Use this command inside a group.');
            return true;
        }
        const sub = args.toLowerCase().split(/ +/)[0];
        const rest = ['add', 'post', 'upload'].includes(sub) ? args.slice(sub.length).trim() : args.trim();

        try {
            const audience = groupMode
                ? await groupAudience(EliteProTech, m.chat)
                : [ownerJid(EliteProTech), m.sender || m.chat].filter(Boolean);

            const content = await buildStatusContent(EliteProTech, m, rest);
            if (!content) {
                await reply(
                    `📸 *${groupMode ? 'GROUP STATUS' : 'STATUS'}*\n\n` +
                    `Reply to a text, image, video or audio with *${prefix}${command}*,\n` +
                    `or type *${prefix}${command} add <your text>*.`
                );
                return true;
            }

            await EliteProTech.sendMessage('status@broadcast', content, {
                backgroundColor: '#0a0a0a',
                font: 3,
                statusJidList: audience,
                broadcast: true
            });
            await reply(`✅ Posted to ${groupMode ? 'the group status' : 'your status'} (${audience.length} viewers).`);
        } catch (err) {
            console.error('groupstatus error:', err?.message || err);
            await reply(`❌ Could not post the status.\n${err?.message || err}`);
        }
        return true;
    }


    /* ---------- MENU BUTTON ---------- */
    if (command === 'menubutton' || command === 'menubuttonchat') {
        if (!args) {
            await reply(menuButtonHelp(prefix));
            return true;
        }
        const parsed = parseMenuButton(args);

        if (parsed.errors.length) {
            await reply(
                `⚠️ *MENU BUTTON — formatting problem*\n\n${parsed.errors.join('\n\n')}\n\n` +
                `Correct format:\n| Label | https://link\n| Label | msg: your text | to: 2349162748703`
            );
            if (!parsed.buttons.length) return true;
        }

        if (!parsed.buttons.length) {
            await reply(
                `⚠️ No button line found.\nAdd at least one line starting with *|*, for example:\n` +
                `| Open Website | https://codebreakers.uk\n\n` +
                menuButtonHelp(prefix)
            );
            return true;
        }

        try {
            const q = quotedInfo(m);
            let image = null;
            if (q && unwrap(q.message).imageMessage) {
                image = await downloadQuoted(EliteProTech, q).catch(() => null);
            } else if (unwrap(m.message || {}).imageMessage) {
                image = await downloadQuoted(EliteProTech, { message: m.message, key: m.key }).catch(() => null);
            }
            await sendButtonPost(EliteProTech, m, parsed.body, parsed.buttons, image, parsed.plain);
        } catch (err) {
            console.error('menubutton error:', err?.message || err);
            await reply(`❌ Failed to send the button message.\n${err?.message || err}`);
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

    if (command.startsWith('antideletegroup')) {
        const opt = args.toLowerCase().trim();
        const config = readJson(ANTIDELETE_GROUP_FILE, { all: false, chats: {} });
        config.chats = config.chats || {};
        const isGroup = String(m.chat || '').endsWith('@g.us');
        // .antideletegroup-public / .antideletegroup-private, or ".antideletegroup public enable"
        let mode = command.includes('-public') ? 'public' : command.includes('-private') ? 'private' : null;
        if (!mode && /^(public|private)/.test(opt)) mode = opt.split(/ +/)[0];
        const action = opt.replace(/^(public|private)\s*/, '').trim();
        const current = config.chats[m.chat];
        const currentMode = current === true ? 'public' : current || null;

        if (action === 'enable' || action === 'on' || (mode && !action)) {
            if (!isGroup) {
                await reply('ℹ️ Use this command inside the group you want to protect.');
                return true;
            }
            config.chats[m.chat] = mode || 'public';
            writeJson(ANTIDELETE_GROUP_FILE, config);
            const anti = readJson(ANTIDELETE_FILE, { enabled: false });
            anti.enabled = true;
            writeJson(ANTIDELETE_FILE, anti);
            await reply(
                config.chats[m.chat] === 'private'
                    ? '🔒 *Anti-delete group: PRIVATE.*\nDeleted messages in this group are restored to your DM only.'
                    : '📢 *Anti-delete group: PUBLIC.*\nDeleted messages are restored inside this group, tagging who sent it and who deleted it.'
            );
            return true;
        }
        if (action === 'disable' || action === 'off') {
            if (isGroup) delete config.chats[m.chat];
            config.all = false;
            writeJson(ANTIDELETE_GROUP_FILE, config);
            await reply('❌ *Anti-delete group disabled for this group.*');
            return true;
        }
        await reply(
            `🛡️ *ANTI DELETE GROUP*\n\nStatus here: ${currentMode ? `✅ ${currentMode.toUpperCase()}` : '❌ DISABLED'}\n\n` +
            `*${prefix}antideletegroup-public enable* — restore inside the group\n` +
            `*${prefix}antideletegroup-private enable* — restore to your DM\n` +
            `*${prefix}antideletegroup-public disable* — turn it off`
        );
        return true;
    }

    /* ---------- CHATBOT SWITCHES + PERSONALITIES ---------- */
    if (command === 'chatbot' || command === 'chatbot-friend' || command === 'chatbot-love') {
        const store = readJson(CHATBOT_FILE, {});
        store.chats = store.chats || {};
        store.modes = store.modes || {};
        const parts = args.toLowerCase().split(/ +/).filter(Boolean);
        const persona = command === 'chatbot-friend' ? 'friend' : command === 'chatbot-love' ? 'love' : null;
        const scope = parts[0] || '';
        const state = parts[parts.length - 1];
        const on = state === 'on' || state === 'enable';
        const off = state === 'off' || state === 'disable';

        /* gender: ".chatbot gender male", ".chatbot-love gender female", etc. */
        if (scope === 'gender') {
            store.genders = store.genders || {};
            const want = parts[1];
            if (want === 'male' || want === 'female') {
                store.genders[m.chat] = want;
                if (persona) store.modes[m.chat] = persona;
                writeJson(CHATBOT_FILE, store);
                await reply(
                    `${want === 'female' ? '👩' : '👨'} Chatbot gender set to *${want}*.\n` +
                    `The bot now chats as a ${want === 'female' ? 'girl' : 'guy'} in this chat.`
                );
                return true;
            }
            if (want === 'off' || want === 'reset' || want === 'none') {
                delete store.genders[m.chat];
                writeJson(CHATBOT_FILE, store);
                await reply('✅ Chatbot gender cleared.');
                return true;
            }
            await reply(
                `⚧ *CHATBOT GENDER*\n\nCurrent: *${store.genders[m.chat] || 'not set'}*\n\n` +
                `*${prefix}${command} gender male*\n*${prefix}${command} gender female*\n*${prefix}${command} gender off*`
            );
            return true;
        }


        if (persona) {
            if (off) {
                delete store.modes[m.chat];
                writeJson(CHATBOT_FILE, store);
                await reply(`✅ Back to the normal chatbot personality here.`);
                return true;
            }
            store.modes[m.chat] = persona;
            store.chats[m.chat] = true;
            writeJson(CHATBOT_FILE, store);
            await reply(
                persona === 'love'
                    ? '💖 *Chatbot-love enabled here.* I now chat with a warm, romantic, affectionate personality — it keeps learning from real human love talk online.'
                    : '🤝 *Chatbot-friend enabled here.* I now chat like a close, loyal friend — relaxed, supportive and playful.'
            );
            return true;
        }

        if ((scope === 'here' || scope === 'this') && (on || off)) {
            if (on) store.chats[m.chat] = true;
            else delete store.chats[m.chat];
            writeJson(CHATBOT_FILE, store);
            await reply(on ? '🤖 Chatbot is now ON in this chat.' : '🤖 Chatbot is now OFF in this chat.');
            return true;
        }
        if (scope === 'dm' && (on || off)) {
            store.dm = on;
            writeJson(CHATBOT_FILE, store);
            await reply(on ? '🤖 Chatbot is now ON for all DMs.' : '🤖 Chatbot is now OFF for DMs.');
            return true;
        }
        if (scope === 'group' && (on || off)) {
            store.group = on;
            writeJson(CHATBOT_FILE, store);
            await reply(on ? '🤖 Chatbot is now ON in all groups.' : '🤖 Chatbot is now OFF in groups.');
            return true;
        }
        if (scope === 'all' || scope === 'global') {
            store.global = on;
            writeJson(CHATBOT_FILE, store);
            await reply(on ? '🤖 Chatbot is now ON everywhere.' : '🤖 Chatbot is now OFF everywhere.');
            return true;
        }
        if (on || off) {
            store.chats[m.chat] = on || undefined;
            if (!on) delete store.chats[m.chat];
            writeJson(CHATBOT_FILE, store);
            await reply(on ? '🤖 Chatbot is now ON in this chat.' : '🤖 Chatbot is now OFF in this chat.');
            return true;
        }

        const here = store.global || store.chats[m.chat] === true ||
            (String(m.chat).endsWith('@g.us') ? store.group : store.dm);
        await reply(
            `🤖 *CHATBOT*\n\nHere: ${here ? '✅ ON' : '❌ OFF'}\nDMs: ${store.dm ? '✅' : '❌'}  |  Groups: ${store.group ? '✅' : '❌'}\n` +
            `Personality here: *${store.modes[m.chat] || 'normal'}*\n` +
            `Gender here: *${(store.genders || {})[m.chat] || 'not set'}*\n\n` +
            `*${prefix}chatbot dm on/off*\n*${prefix}chatbot group on/off*\n*${prefix}chatbot here on/off*\n` +
            `*${prefix}chatbot all on/off*\n*${prefix}chatbot gender male/female*\n` +
            `*${prefix}chatbot-friend* / *${prefix}chatbot-love* (add *off* to reset)\n` +
            `*${prefix}chatbot-love gender female* / *${prefix}chatbot-friend gender male*`
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
    addAfter('│𖥟╾ Antidelete\n', '│𖥟╾ Antideletemessage\n│𖥟╾ Chatbotname\n│𖥟╾ Username\n│𖥟╾ Addstatus\n│𖥟╾ Chatbot-friend\n│𖥟╾ Chatbot-love\n│𖥟╾ Chatbot gender\n', 'settings-commands');
    // GROUP
    addAfter('│𖥟╾ Tagadmin\n', '│𖥟╾ Antideletegroup-public\n│𖥟╾ Antideletegroup-private\n│𖥟╾ Grouppp\n│𖥟╾ Groupfullpp\n│𖥟╾ Groupstatus\n', 'group-commands');
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
    const menuCall = 'await global.sendMenu(EliteProTech, m, elitepropic, elitemenuoh);';
    if (code.includes(menuSend)) {
        code = code.split(menuSend).join(menuCall);
    } else {
        // Whitespace/formatting in the remote source can change; match loosely
        // so the menu is always routed through our sender instead of silently
        // never being delivered.
        const loose = /await\s+EliteProTech\.sendMessage\(\s*m\.chat\s*,\s*\{\s*image\s*:\s*elitepropic\s*,\s*caption\s*:\s*elitemenuoh\s*,?\s*\}\s*,\s*\{[^}]*\}\s*\)\s*;?/g;
        if (loose.test(code)) {
            code = code.replace(loose, menuCall);
        } else {
            console.log('⚠️ Menu button patch target not found.');
        }
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
        if (await handleButtonPress(EliteProTech, m)) return;
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
