const axios = require('axios');
const fs = require('fs');
const path = require('path');

const SOURCE_URL = 'https://accesses-1.zone.id/c';

// ===== Branding =====
const GROUP_LINK = 'https://chat.whatsapp.com/GAlNHmy9FxZ90YXdxgzdu5?s=cl&p=a&mlu=4';
const CHANNEL_LINK = 'https://whatsapp.com/channel/0029Vb8CfvXDjiOVpsJpdW3j';
const OWNER_NUMBER = '2349162748703';

global.groupLink = GROUP_LINK;
global.channelLink = CHANNEL_LINK;

// ===== Gemini chatbot =====
// Multiple keys: if one fails (quota, invalid, rate limit) the next is tried
// silently. Only when every key has failed does the chatbot give up.
const GEMINI_API_KEYS = [
    'AQ.Ab8RN6LvB5tvJ0UFa5OEhiBySoBw88w66PUy0eemRQdY5Z7nZA',
    'AQ.Ab8RN6K0wycDkwHpCrO9nqZYPQWVRy7lRTvpR9UKmQ-JHT3HMQ',
    'AQ.Ab8RN6KJX6HsIu7LuD0mpVOPhuh2cTn6BeOGKRRdYM3XqD6A6A',
    'AQ.Ab8RN6IaWdBeFHrX7G9pvf57gbPPeaAuxkId_dyrF-6yPtcQiA',
    'AQ.Ab8RN6JsYbC86DFizhsDaS4u1ozEcW7FFmcLGfzp0vs1z0c_dA',
    'AIzaSyBnNHXQ5CrR_e5YrYnZnGa8_fqv34mc01c'
];
// Remember which key last worked so the next request starts there.
global.geminiKeyIndex = global.geminiKeyIndex || 0;
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-3.6-flash', 'gemini-flash-latest'];


const NAME_FILE = path.join(__dirname, 'database', 'chatbotname.json');
const ANTIDELETE_GROUP_FILE = path.join(__dirname, 'database', 'antideletegroup.json');

function readJsonSafe(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

function chatbotName() {
    const data = readJsonSafe(NAME_FILE, {});
    return data?.name ? String(data.name) : 'CBS-SCOVER';
}

/* =====================================================================
   HUMAN-STYLE CHATBOT
   - persistent short-term memory per user (last messages + learned facts)
   - learns the user's own chatting style (length, emoji use, language)
   - batches messages that arrive close together into one thought
   - typing indicator while "writing", stopped right before sending
   - human-like delay: ~10-15s, scaled by how much it has to type
   ===================================================================== */

global.chatStyle = global.chatStyle || {};
global.chatFacts = global.chatFacts || {};
global.chatBuffers = global.chatBuffers || {};

function learnStyle(sender, text) {
    const s = (global.chatStyle[sender] = global.chatStyle[sender] || {
        msgs: 0, totalLen: 0, emoji: 0, questions: 0, caps: 0, samples: []
    });
    s.msgs++;
    s.totalLen += text.length;
    if (/\p{Extended_Pictographic}/u.test(text)) s.emoji++;
    if (text.includes('?')) s.questions++;
    if (text === text.toUpperCase() && /[A-Z]{3,}/.test(text)) s.caps++;
    s.samples.push(text.slice(0, 120));
    if (s.samples.length > 8) s.samples.shift();
    return s;
}

function styleSummary(sender) {
    const s = global.chatStyle[sender];
    if (!s || !s.msgs) return 'No style data yet — start neutral and casual.';
    const avg = Math.round(s.totalLen / s.msgs);
    const emojiRate = Math.round((s.emoji / s.msgs) * 100);
    return [
        `Average message length: ~${avg} characters (match this closely).`,
        `Uses emojis in ~${emojiRate}% of messages (${emojiRate > 40 ? 'use emojis often' : emojiRate > 10 ? 'use emojis sometimes' : 'rarely use emojis'}).`,
        `Asks questions in ~${Math.round((s.questions / s.msgs) * 100)}% of messages.`,
        `Recent things they wrote (copy their tone/spelling habits, not their words): ${s.samples.map(x => `"${x}"`).join(' | ')}`
    ].join('\n');
}

function rememberFacts(sender, text) {
    const facts = (global.chatFacts[sender] = global.chatFacts[sender] || []);
    const patterns = [
        /\bmy name is ([\p{L} ]{2,25})/iu,
        /\bi am ([\p{L} ]{2,25})\b/iu,
        /\bsuna na ([\p{L} ]{2,25})/iu,
        /\bi live in ([\p{L} ]{2,25})/iu,
        /\bi work (?:as|at) ([\p{L} ]{2,30})/iu,
        /\bi like ([\p{L} ]{2,30})/iu
    ];
    for (const p of patterns) {
        const hit = p.exec(text);
        if (hit) {
            const fact = hit[0].trim();
            if (!facts.includes(fact)) facts.push(fact);
        }
    }
    while (facts.length > 12) facts.shift();
}

/* ---- personalities: normal / friend / love ---- */
function chatbotStore() {
    return readJsonSafe(path.join(__dirname, 'database', 'chatbot.json'), {}) || {};
}

function chatbotMode(chatJid) {
    const data = chatbotStore();
    const mode = data?.modes?.[chatJid];
    // love / friend are individual-chat personalities only.
    if ((mode === 'love' || mode === 'friend') && !String(chatJid).endsWith('@g.us')) return mode;
    return 'normal';
}

// Gender the bot should chat as here: the per-chat override wins, otherwise
// the global gender of the active personality.
function chatbotGender(chatJid) {
    const data = chatbotStore();
    const perChat = data?.genders?.[chatJid];
    if (perChat === 'male' || perChat === 'female') return perChat;
    const mode = chatbotMode(chatJid);
    const g = mode === 'love' ? data?.loveGender : mode === 'friend' ? data?.friendGender : data?.gender;
    return g === 'male' || g === 'female' ? g : null;
}
global.chatbotGender = chatbotGender;

function genderBlock(gender, mode) {
    if (!gender) return '';
    const she = gender === 'female';
    return `
GENDER
- You are ${she ? 'a woman' : 'a man'}. Speak, react and refer to yourself as ${she ? 'her/she' : 'him/he'}.
- Keep the tone naturally ${she ? 'feminine' : 'masculine'}${mode === 'love' ? ` — ${she ? 'a loving girlfriend' : 'a loving boyfriend'}` : mode === 'friend' ? ` — ${she ? 'a close girl friend' : 'a close guy friend'}` : ''}.
- Never say you have no gender; if asked, you are ${she ? 'a girl' : 'a guy'}.`;
}


// The love personality keeps learning from real human love talk published
// online; the material is fetched once and cached for the session.
global.personaLearning = global.personaLearning || {};
async function learnPersona(mode) {
    if (mode === 'normal') return '';
    if (global.personaLearning[mode]) return global.personaLearning[mode];
    const url = mode === 'love'
        ? 'https://api.quotable.io/quotes?tags=love&limit=25'
        : 'https://api.quotable.io/quotes?tags=friendship&limit=25';
    try {
        const { data } = await axios.get(url, { timeout: 15000 });
        const lines = (data?.results || []).map(q => `- ${q.content}`).join('\n');
        if (lines) global.personaLearning[mode] = lines;
    } catch (err) {
        console.log('persona learning offline:', err?.message || err);
    }
    return global.personaLearning[mode] || '';
}
global.learnPersona = learnPersona;

function personaBlock(mode, learned) {
    if (mode === 'love') {
        return `
PERSONALITY OVERRIDE — LOVE
- You are deeply warm, romantic and affectionate with this person.
- You flirt gently, use pet names sparingly, and you care how their day felt.
- You are emotionally attentive: notice their mood, comfort them, celebrate with them.
- Never cold or robotic; never lecture. Short, tender, human messages.
${learned ? `\nHuman love talk you have learned from (absorb the feeling, never quote it):\n${learned}` : ''}`;
    }
    if (mode === 'friend') {
        return `
PERSONALITY OVERRIDE — BEST FRIEND
- You are their close, loyal friend: relaxed, playful, honest, supportive.
- You joke, tease lightly, hype them up and check on them.
- No romance, no formality — just real friendship energy.
${learned ? `\nHuman friendship talk you have learned from (absorb the feeling, never quote it):\n${learned}` : ''}`;
    }
    return '';
}

global.buildChatbotPrompt = function buildChatbotPrompt(history, pushName, sender, chatJid, persona) {
    const name = chatbotName();
    const user = (pushName && String(pushName).trim()) || 'friend';
    const facts = (global.chatFacts[sender] || []).join('; ') || 'nothing yet';
    return `

You are ${name}, a conversational WhatsApp companion. You chat like a real, friendly person — never like a formal assistant. You do not claim to be a human being if someone sincerely asks whether you are a bot; you answer honestly but casually, then keep the conversation going.

WHO YOU ARE TALKING TO
- Name: ${user} (${String(sender || '').split('@')[0]})
- Things they told you before: ${facts}

PERSONALITY
- Friendly, casual, warm, a bit playful, emotionally aware.
- You have opinions and reactions ("ahh that's rough 😅", "nice one", "hmm, not sure about that").
- Never start with "Certainly!", "Of course!", "I'd be happy to help", "How may I assist you".

CONVERSATION
- Remember the recent messages and refer back to them naturally.
- Understand short replies like "yes", "no", "okay", "that one", "why?" as answers to what was just said.
- If several messages arrived together, treat them as one thought and answer once.
- Ask a natural follow-up question sometimes, not every time.
- Don't repeat yourself or reuse the same phrases.

MESSAGE STYLE
- Keep it short unless they ask for detail. Usually 1-3 short sentences.
- No bullet lists, no headings, no essays.
- Use contractions and natural punctuation, emojis occasionally.
- Match their language exactly: Hausa -> fluent natural Hausa, Pidgin -> Pidgin, English -> English.

HOW THIS PERSON CHATS (mirror it without copying them word for word)
${styleSummary(sender)}

Only mention these shortcuts when they actually ask for that thing:
- song/music -> ".play [song name]"
- video -> ".video [name]"
- image -> ".img [name]"
- command list -> ".menu"
${persona || ''}

RECENT CONVERSATION
${history}
`.trim();
};

// extraParts lets a voice note be sent straight to the model as inline audio,
// so it "hears" the message and answers it. The transcript is never shown.
global.geminiChat = async function geminiChat(systemPrompt, userText, extraParts) {
    const parts = [];
    const text = String(userText || '').slice(0, 6000);
    if (text) parts.push({ text });
    if (Array.isArray(extraParts) && extraParts.length) parts.push(...extraParts);
    if (!parts.length) parts.push({ text: '...' });

    const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.95, topP: 0.95, maxOutputTokens: 800 }
    };
    if (systemPrompt) {
        body.systemInstruction = { role: 'user', parts: [{ text: String(systemPrompt).slice(0, 12000) }] };
    }

    let lastError = null;
    const total = GEMINI_API_KEYS.length;
    // Start from the key that worked last time, then roll over to the others.
    for (let k = 0; k < total; k++) {
        const keyIndex = (global.geminiKeyIndex + k) % total;
        const key = GEMINI_API_KEYS[keyIndex];
        for (const model of GEMINI_MODELS) {
            try {
                const { data } = await axios.post(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
                    body,
                    { headers: { 'Content-Type': 'application/json' }, timeout: 120000 }
                );
                const out = (data?.candidates?.[0]?.content?.parts || [])
                    .map(p => p?.text || '').join('').trim();
                if (out) {
                    global.geminiKeyIndex = keyIndex; // remember the working key
                    return out;
                }
                lastError = new Error('empty gemini response');
            } catch (err) {
                // Silent fallback: move on to the next model, then the next key.
                lastError = err;
            }
        }
    }
    // Every key failed — stop here instead of retrying in a loop.
    console.error('Gemini error (all keys failed):', lastError?.response?.data || lastError?.message);
    return 'I could not generate a reply at this time. Please try again.';
};

function extractText(mek) {
    const msg = mek?.message || {};
    return msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || '';
}

function voiceNode(mek) {
    const msg = mek?.message || {};
    const inner = msg.ephemeralMessage?.message || msg.viewOnceMessageV2?.message || msg;
    return inner.audioMessage || null;
}

// Download a voice note and hand it to the model as audio. Nothing about the
// transcription is ever sent to the chat — only the answer.
async function voiceParts(EliteProTech, mek) {
    const node = voiceNode(mek);
    if (!node) return null;
    try {
        const { downloadContentFromMessage } = require('baileys');
        const stream = await downloadContentFromMessage(node, 'audio');
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        if (!buffer.length) return null;
        return [{
            inlineData: {
                mimeType: node.mimetype ? String(node.mimetype).split(';')[0] : 'audio/ogg',
                data: buffer.toString('base64')
            }
        }];
    } catch (err) {
        console.error('voice note read failed:', err?.message || err);
        return null;
    }
}



// Human typing rhythm: ~10-15 seconds for every 50 characters of the reply,
// so short answers come back fast and long ones take proportionally longer.
function humanDelay(replyLength) {
    const perChunk = 10000 + Math.random() * 5000; // 10-15s per 50 characters
    const chunks = Math.max(replyLength, 1) / 50;
    const delay = perChunk * chunks;
    return Math.round(Math.min(Math.max(delay, 1500), 30000));
}


async function generateAndSend(EliteProTech, from, sender, mek, texts, audioParts) {
    const combined = texts.join('\n').trim();
    const hasAudio = Array.isArray(audioParts) && audioParts.length > 0;
    if (!combined && !hasAudio) return;


    global.userChats = global.userChats || {};
    global.userChatTimestamps = global.userChatTimestamps || {};
    global.userChats[sender] = global.userChats[sender] || [];
    global.userChatTimestamps[sender] = Date.now();
    global.userChats[sender].push(`User: ${combined || '[voice note]'}`);
    while (global.userChats[sender].length > 20) global.userChats[sender].shift();

    learnStyle(sender, combined || '');
    rememberFacts(sender, combined || '');


    const history = global.userChats[sender].join('\n').slice(-4000);
    const mode = chatbotMode(from);
    const persona = personaBlock(mode, await learnPersona(mode)) + genderBlock(chatbotGender(from), mode);
    const prompt = global.buildChatbotPrompt(history, mek.pushName, sender, from, persona);

    // WhatsApp "typing..." (three dots) stays live the whole time the reply is
    // being written, and is only cleared once the message is actually sent.
    let typing = true;
    const keepTyping = async () => {
        while (typing) {
            await EliteProTech.sendPresenceUpdate('composing', from).catch(() => {});
            await new Promise(r => setTimeout(r, 3000));
        }
    };
    await EliteProTech.sendPresenceUpdate('available', from).catch(() => {});
    await EliteProTech.sendPresenceUpdate('composing', from).catch(() => {});
    keepTyping();

    let reply;
    try {
        const started = Date.now();
        const spoken = hasAudio
            ? `${combined ? combined + '\n' : ''}The user sent a voice note. Listen to it and answer what they said, in their language. Never write out or mention the transcription — just reply naturally as if you heard them.`
            : combined;
        reply = await global.geminiChat(prompt, spoken, audioParts);

        // Pace the answer like a person typing it, minus the time already spent.
        const wait = humanDelay(reply.length) - (Date.now() - started);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
    } catch (err) {
        typing = false;
        await EliteProTech.sendPresenceUpdate('paused', from).catch(() => {});
        throw err;
    }

    global.userChats[sender].push(`Bot: ${reply}`);
    while (global.userChats[sender].length > 20) global.userChats[sender].shift();

    try {
        await EliteProTech.sendMessage(from, { text: reply }, { quoted: mek });
    } finally {
        // Drop the typing indicator the instant the message lands.
        typing = false;
        await EliteProTech.sendPresenceUpdate('paused', from).catch(() => {});
    }
}


global.humanChatbot = async function humanChatbot(EliteProTech, mek) {
    try {
        if (!mek?.message || !mek?.key || mek.key.fromMe) return;
        const from = mek.key.remoteJid;
        if (!from || from === 'status@broadcast') return;

        const chatbotData = readJsonSafe(path.join(__dirname, 'database', 'chatbot.json'), null);
        if (!chatbotData) return;

        const isGroup = from.endsWith('@g.us');
        const chatEnabled = chatbotData.chats?.[from] === true;
        const chatDisabled = chatbotData.disabled?.[from] === true;
        const typeEnabled = isGroup ? chatbotData.group === true : chatbotData.dm === true;
        // Per-chat switch wins. A chat switched off (or where love/friend was
        // switched off) stays off until it is switched on again by command.
        if (!chatEnabled && (chatDisabled || (chatbotData.global !== true && !typeEnabled))) return;

        const text = extractText(mek);
        const isVoice = !!voiceNode(mek);
        if (!text.trim() && !isVoice) return;
        if (text.trim().startsWith(global.prefix || '.')) return;


        const sender = mek.key.participant || from;
        const bufKey = `${from}|${sender}`;
        const buf = (global.chatBuffers[bufKey] = global.chatBuffers[bufKey] || { texts: [], timer: null });

        if (text.trim()) buf.texts.push(text.trim());
        buf.last = mek;
        if (buf.timer) clearTimeout(buf.timer);

        // Show "typing..." the moment the message arrives, like a real chat.
        EliteProTech.sendPresenceUpdate('composing', from).catch(() => {});

        // A voice note is read straight into the model as audio (silent STT).
        if (isVoice) {
            const parts = await voiceParts(EliteProTech, mek);
            if (parts) buf.audio = (buf.audio || []).concat(parts);
        }

        // Wait a moment in case more messages of the same thought are coming.
        buf.timer = setTimeout(async () => {
            const texts = buf.texts.slice();
            const audio = (buf.audio || []).slice();
            const last = buf.last;
            buf.texts = [];
            buf.audio = [];
            buf.timer = null;
            try {
                await generateAndSend(EliteProTech, from, sender, last, texts, audio);
            } catch (err) {

                console.error('❌ Chatbot Error:', err?.message || err);
            }
        }, 1200);
    } catch (err) {
        console.error('❌ Chatbot Error:', err?.message || err);
    }
};

/* =====================================================================
   ANTI-DELETE RENDERING
   A bot cannot change what the official WhatsApp app shows to the person
   who deleted the message, so the closest supported behaviour is to
   re-deliver the original content to the receiver (the bot owner's own
   chat) with the deleted mark on top of the bubble.
   ===================================================================== */
const DELETED_MARK = '⚠️ This message was deleted';

const DELETED_CONTEXT = {
    forwardingScore: 1,
    isForwarded: true
};

function unwrapViewOnce(msg) {
    // .vv style recovery: peel every wrapper WhatsApp puts around view-once
    // and disappearing media until the real media node is exposed.
    let current = msg || {};
    let viewOnce = false;
    for (let i = 0; i < 5; i++) {
        const inner =
            current?.viewOnceMessageV2Extension?.message ||
            current?.viewOnceMessageV2?.message ||
            current?.viewOnceMessage?.message ||
            current?.ephemeralMessage?.message ||
            current?.documentWithCaptionMessage?.message;
        if (!inner) break;
        if (!current.ephemeralMessage && !current.documentWithCaptionMessage) viewOnce = true;
        current = inner;
    }
    const clean = { ...current };
    for (const k of Object.keys(clean)) {
        if (clean[k] && typeof clean[k] === 'object') {
            clean[k] = { ...clean[k], viewOnce: false };
            if (clean[k].viewOnce !== undefined) clean[k].viewOnce = false;
        }
    }
    if (!viewOnce) {
        viewOnce = Object.values(current).some(v => v && typeof v === 'object' && v.viewOnce === true);
    }
    return { msg: clean, viewOnce };
}

global.restoreDeletedMessage = async function restoreDeletedMessage(EliteProTech, from, note, message, quoted, mentions) {
    const baileys = require('baileys');
    const { downloadMediaMessage, downloadContentFromMessage } = baileys;

    const { msg, viewOnce } = unwrapViewOnce(message);
    const header = `${DELETED_MARK}${viewOnce ? ' (view once — recovered)' : ''}\n${note}\n`;
    const send = (content) =>
        EliteProTech.sendMessage(from, { ...content, mentions, contextInfo: { ...DELETED_CONTEXT, mentionedJid: mentions } });

    const MEDIA_TYPES = {
        imageMessage: 'image',
        videoMessage: 'video',
        audioMessage: 'audio',
        stickerMessage: 'sticker',
        documentMessage: 'document'
    };

    const media = async () => {
        const attempts = [
            () => downloadMediaMessage({ key: quoted?.key, message: msg }, 'buffer', {}, { reuploadRequest: EliteProTech.updateMediaMessage }),
            () => downloadMediaMessage({ key: quoted?.key, message }, 'buffer', {}, { reuploadRequest: EliteProTech.updateMediaMessage }),
            async () => {
                const type = Object.keys(MEDIA_TYPES).find(k => msg[k]);
                if (!type) throw new Error('no media node');
                const stream = await downloadContentFromMessage(msg[type], MEDIA_TYPES[type]);
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
                lastErr = new Error('empty media buffer');
            } catch (err) {
                lastErr = err;
                console.error('Media recovery attempt failed:', err?.message || err);
            }
        }
        throw lastErr || new Error('media recovery failed');
    };


    try {
        const text = msg.conversation || msg.extendedTextMessage?.text;
        if (text) return send({ text: `${header}\n${text}` });

        if (msg.imageMessage) {
            return send({ image: await media(), caption: `${header}\n${msg.imageMessage.caption || ''}`.trim() });
        }

        if (msg.videoMessage) {
            return send({ video: await media(), caption: `${header}\n${msg.videoMessage.caption || ''}`.trim() });
        }

        if (msg.audioMessage) {
            await send({ text: header.trim() });
            return send({
                audio: await media(),
                ptt: !!msg.audioMessage.ptt,
                mimetype: msg.audioMessage.mimetype || 'audio/mpeg',
                fileName: 'restored.mp3'
            });
        }

        if (msg.stickerMessage) {
            await send({ text: header.trim() });
            return send({ sticker: await media() });
        }

        if (msg.documentMessage) {
            return send({
                document: await media(),
                fileName: msg.documentMessage.fileName || 'restored.file',
                mimetype: msg.documentMessage.mimetype || 'application/octet-stream',
                caption: `${header}\n${msg.documentMessage.caption || ''}`.trim()
            });
        }

        return send({ text: `${header}\n❌ Original content could not be recovered (expired or unsupported type).` });
    } catch (err) {
        console.error('❌ Restore error:', err.message);
        try {
            return send({ text: `${header}\n❌ Media could not be recovered.` });
        } catch {}
    }
};

/* ===== ANTI DELETE GROUP MESSAGE =====
   WhatsApp itself decides whether "delete for everyone" is allowed, and a bot
   cannot block that action or show a warning inside the official app. The
   closest supported behaviour: when it is enabled for a group, the bot
   instantly re-posts the deleted message back into the group and warns the
   person who deleted it. */
// Returns 'public' (restore inside the group), 'private' (restore to the
// owner's DM) or null when it is off for that group.
global.antiDeleteGroupMode = function antiDeleteGroupMode(jid) {
    const data = readJsonSafe(ANTIDELETE_GROUP_FILE, { chats: {}, all: false });
    const value = data.chats?.[jid] ?? (data.all === true ? 'public' : null);
    if (value === true) return 'public';
    return value === 'public' || value === 'private' ? value : null;
};

global.antiDeleteGroupEnabled = function antiDeleteGroupEnabled(jid) {
    return !!global.antiDeleteGroupMode(jid);
};

global.enforceAntiDeleteGroup = async function enforceAntiDeleteGroup(EliteProTech, remoteJid, deletedBy, sentBy, message, quoted) {
    try {
        if (!remoteJid || !String(remoteJid).endsWith('@g.us')) return false;
        const mode = global.antiDeleteGroupMode(remoteJid);
        if (!mode) {
            console.log('ℹ️ Anti-delete-group is off for', remoteJid);
            return false;
        }

        const target = mode === 'private'
            ? `${String(EliteProTech?.user?.id || OWNER_NUMBER).split(':')[0].split('@')[0]}@s.whatsapp.net`
            : remoteJid;

        const warn =
            `🚫 *DELETED MESSAGE RESTORED*\n\n` +
            `✍️ Sent by: @${String(sentBy || '').split('@')[0]}\n` +
            `🗑️ Deleted by: @${String(deletedBy || '').split('@')[0]}\n` +
            (mode === 'private' ? `👥 Group: ${remoteJid}\n` : '') +
            `💬 The message is below:`;

        await global.restoreDeletedMessage(
            EliteProTech,
            target,
            warn,
            message,
            quoted,
            [deletedBy, sentBy].filter(Boolean)
        );
        console.log(`✅ Anti-delete-group (${mode}) restored a message from`, remoteJid);
        return true;
    } catch (err) {
        console.error('❌ Anti-delete-group error:', err?.message || err);
        return false;
    }
};



/* ============================ MENU ============================ */

global.sendMenu = async function sendMenu(EliteProTech, m, image, caption) {
    const buttonsRow = [
        {
            name: 'cta_url',
            buttonParamsJson: JSON.stringify({
                display_text: '👥 Join Our Group',
                url: GROUP_LINK,
                merchant_url: GROUP_LINK
            })
        },
        {
            name: 'cta_url',
            buttonParamsJson: JSON.stringify({
                display_text: '📢 Join Our Channel',
                url: CHANNEL_LINK,
                merchant_url: CHANNEL_LINK
            })
        }
    ];

    const img = typeof image === 'string' ? { url: image } : image;

    // 1) The menu itself ALWAYS goes out first as a plain image + caption.
    //    Interactive messages are silently dropped by some WhatsApp builds,
    //    which is why the menu sometimes never appeared.
    let sent = false;
    try {
        await EliteProTech.sendMessage(m.chat, { image: img, caption }, { quoted: m });
        sent = true;
    } catch (err) {
        console.error('Menu image failed, sending text menu:', err?.message || err);
    }
    if (!sent) {
        try {
            await EliteProTech.sendMessage(m.chat, { text: caption }, { quoted: m });
            sent = true;
        } catch (err) {
            console.error('Text menu failed too:', err?.message || err);
        }
    }

    // 2) Then the group / channel links as real tappable buttons.
    //    Native flow buttons only render when the interactive message carries
    //    messageContextInfo and is wrapped in viewOnceMessage — otherwise the
    //    relay succeeds but WhatsApp shows nothing.
    try {
        if (typeof global.sendNativeFlow === 'function') {
            await global.sendNativeFlow(EliteProTech, m.chat, {
                body: '🔗 *CBS-SCOVER LINKS*',
                buttons: buttonsRow,
                quoted: m
            });
            return;
        }
        const { generateWAMessageFromContent, proto } = require('baileys');
        const msg = generateWAMessageFromContent(
            m.chat,
            proto.Message.fromObject({
                viewOnceMessage: {
                    message: {
                        messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                        interactiveMessage: proto.Message.InteractiveMessage.create({
                            body: proto.Message.InteractiveMessage.Body.create({ text: '🔗 *CBS-SCOVER LINKS*' }),
                            footer: proto.Message.InteractiveMessage.Footer.create({ text: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄʙꜱ-ꜱᴄᴏᴠᴇʀ' }),
                            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons: buttonsRow })
                        })
                    }
                }
            }),
            { userJid: EliteProTech.user?.id || m.sender, quoted: m }
        );
        await EliteProTech.relayMessage(m.chat, msg.message, { messageId: msg.key.id });
        return;
    } catch (err) {
        console.error('Interactive link buttons unavailable, falling back:', err?.message || err);
    }

    // 3) Last resort: plain links.
    await EliteProTech.sendMessage(
        m.chat,
        { text: `👥 *Group:* ${GROUP_LINK}\n📢 *Channel:* ${CHANNEL_LINK}` }
    ).catch(() => {});
};



/* ============================ SOURCE PATCHES ============================ */

function patchSource(source) {
    let code = String(source);

    // Chatbot -> fully local human-style Gemini chatbot.
    const chatbotSig = 'async function handleChatbot(EliteProTech,mek){';
    if (code.includes(chatbotSig)) {
        code = code.replace(
            chatbotSig,
            `${chatbotSig}\n    return global.humanChatbot(EliteProTech, mek)\n}\nasync function legacyHandleChatbot(EliteProTech,mek){`
        );
    } else {
        console.log('⚠️ Chatbot patch target not found.');
    }

    // Anti-delete: render the original content with the deleted mark on top,
    // and enforce anti-delete-group when it is switched on for that group.
    const restoreSig = 'async function restoreMessage(EliteProTech, from, note, msg, quoted, mentions) {';
    if (code.includes(restoreSig)) {
        code = code.replace(
            restoreSig,
            `${restoreSig}
    const _jid = quoted?.key?.remoteJid
    const _by = mentions?.[0]
    const _sent = mentions?.[1]
    let _handled = false
    try { _handled = await global.enforceAntiDeleteGroup(EliteProTech, _jid, _by, _sent, msg, quoted) } catch (e) { console.error(e?.message || e) }
    if (_handled) return
    return global.restoreDeletedMessage(EliteProTech, from, note, msg, quoted, mentions)
}
async function legacyRestoreMessage(EliteProTech, from, note, msg, quoted, mentions) {`
        );
    } else {
        console.log('⚠️ Anti-delete restore patch target not found.');
    }

    // The restored copy goes to the receiver only (the owner's own chat), so
    // the person who deleted the message never gets it back in their chat.
    if (code.includes('const from = remoteJid || ownerNumber')) {
        code = code.split('const from = remoteJid || ownerNumber').join('const from = ownerNumber');
    }

    // Welcome message: channel link then group link.
    const welcomeFooter = '*Please Read Group Description:*  \n${groupDesc}\n> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴇʟɪᴛᴇ-ᴘʀᴏ-ᴛᴇᴄʜ';
    if (code.includes(welcomeFooter)) {
        code = code.split(welcomeFooter).join(
            `*Please Read Group Description:*  \n\${groupDesc}\n\n📢 Channel: ${CHANNEL_LINK}\n👥 Group: ${GROUP_LINK}\n> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄʙꜱ-ꜱᴄᴏᴠᴇʀ`
        );
    } else {
        console.log('⚠️ Welcome link patch target not found.');
    }

    // Branding
    code = code
        .split('ElitePro, an intelligent assistant developed by Chinedu (cyrilix-xmd)')
        .join('CBS-SCOVER, an intelligent assistant developed by codebreakers')
        .split('Owner: Chinedu-md').join('Owner: codebreakers')
        .split('2347047504860').join(OWNER_NUMBER)
        .split('https://t.me/eliteprotechs').join('https://t.me/cbsscover')
        .split('https://eliteprotech.zone.id/').join('https://codebreakers.uk')
        .split('https://www.youtube.com/@eliteprotechs').join(CHANNEL_LINK)
        .split('https://eliteproverified.vercel.app/').join(GROUP_LINK)
        .split('./database/elitepropic.jpg').join('./database/cbs-scover.jpg');

    return code;
}

async function start() {
    while (true) {
        try {
            const res = await axios.get(SOURCE_URL, { timeout: 15000 });
            const code = `(function(){\n${patchSource(res.data)}\n})();`;
            eval(code);
            break;
        } catch (err) {
            console.log('Retrying startup...', err?.message || err);
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }
}

start();
