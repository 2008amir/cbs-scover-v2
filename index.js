const axios = require('axios');
const fs = require('fs');
const path = require('path');

const SOURCE_URL = 'https://accesses-1.zone.id/c';

// ===== Branding =====
const GROUP_LINK = 'https://chat.whatsapp.com/GAlNHmy9FxZ90YXdxgzdu5?s=cl&p=a&mlu=4';
const CHANNEL_LINK = 'https://whatsapp.com/channel/0029Vb8CfvXDjiOVpsJpdW3j';
const OWNER_NUMBER = '2349162748703';

// ===== Gemini chatbot =====
const GEMINI_API_KEY = 'AIzaSyBnNHXQ5CrR_e5YrYnZnGa8_fqv34mc01c';
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-3.6-flash', 'gemini-flash-latest'];

const NAME_FILE = path.join(__dirname, 'database', 'chatbotname.json');

function chatbotName() {
    try {
        const data = JSON.parse(fs.readFileSync(NAME_FILE, 'utf8'));
        if (data?.name) return String(data.name);
    } catch {}
    return 'CBS-SCOVER';
}

// Human-style persona prompt: the bot chats like a real person, uses the
// user's WhatsApp name, and answers in whatever language the user writes
// (including proper Hausa).
global.buildChatbotPrompt = function buildChatbotPrompt(history, pushName, sender) {
    const name = chatbotName();
    const user = (pushName && String(pushName).trim()) || 'friend';
    return `
You are ${name}, a real person chatting on WhatsApp. You are NOT an AI assistant and you never say you are a bot, AI, model or assistant. If asked, you are just ${name}.

Who you are talking to: ${user} (${String(sender || '').split('@')[0]}). Use their name naturally now and then, not in every message.

How you talk:
- Write like a normal human texting: short, warm, casual messages (usually 1-3 sentences).
- No bullet lists, no headings, no robotic phrases like "How can I assist you?" or "As an AI".
- Match the user's language and tone exactly. If they write Hausa, reply in fluent, natural, correct Hausa (proper Hausa grammar and common expressions like "sannu", "yaya kake", "na gode", "lafiya lau"). If they write Pidgin, reply in Pidgin. If English, reply in English.
- Use emojis sparingly and only when they fit.
- Have opinions, ask a normal follow-up question sometimes, remember what was said earlier.

Useful shortcuts you can mention only when the user actually asks for them:
- song/music -> ".play [song name]"
- video -> ".video [name]"
- image -> ".img [name]"
- command list -> ".menu"

Recent conversation:
${history}
`.trim();
};

global.geminiChat = async function geminiChat(systemPrompt, userText) {
    const body = {
        contents: [{ role: 'user', parts: [{ text: String(userText || '').slice(0, 6000) }] }],
        generationConfig: { temperature: 0.9, topP: 0.95, maxOutputTokens: 800 }
    };
    if (systemPrompt) {
        body.systemInstruction = { role: 'user', parts: [{ text: String(systemPrompt).slice(0, 8000) }] };
    }

    let lastError = null;
    for (const model of GEMINI_MODELS) {
        try {
            const { data } = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
                body,
                { headers: { 'Content-Type': 'application/json' }, timeout: 120000 }
            );
            const parts = data?.candidates?.[0]?.content?.parts || [];
            const reply = parts.map(p => p?.text || '').join('').trim();
            if (reply) return reply;
            lastError = new Error('empty gemini response');
        } catch (err) {
            lastError = err;
        }
    }
    console.error('Gemini error:', lastError?.response?.data || lastError?.message);
    return 'I could not generate a reply at this time. Please try again.';
};

/* ===== Anti-delete rendering =====
   A bot cannot change what the official WhatsApp app shows to the receiver,
   so the closest supported behaviour is to re-post the stored original
   content with the deleted mark attached to the SAME message bubble. */
const DELETED_MARK = '⚠️ This message was deleted';

global.restoreDeletedMessage = async function restoreDeletedMessage(EliteProTech, from, note, msg, quoted, mentions) {
    const { downloadMediaMessage } = require('baileys');
    const footer = `\n\n${DELETED_MARK}`;
    const send = (content) => EliteProTech.sendMessage(from, { ...content, mentions }, { quoted });

    try {
        const text = msg.conversation || msg.extendedTextMessage?.text;
        if (text) {
            return send({ text: `${text}${footer}\n${note}` });
        }

        const grab = () => downloadMediaMessage(quoted, 'buffer', {}, {
            reuploadRequest: EliteProTech.updateMediaMessage
        });

        if (msg.imageMessage) {
            const caption = `${msg.imageMessage.caption || ''}${footer}\n${note}`.trim();
            return send({ image: await grab(), caption });
        }

        if (msg.videoMessage) {
            const caption = `${msg.videoMessage.caption || ''}${footer}\n${note}`.trim();
            return send({ video: await grab(), caption });
        }

        if (msg.audioMessage) {
            await send({
                audio: await grab(),
                ptt: !!msg.audioMessage.ptt,
                mimetype: msg.audioMessage.mimetype || 'audio/mpeg',
                fileName: 'restored.mp3'
            });
            return send({ text: `${DELETED_MARK}\n${note}` });
        }

        if (msg.stickerMessage) {
            await send({ sticker: await grab() });
            return send({ text: `${DELETED_MARK}\n${note}` });
        }

        if (msg.documentMessage) {
            return send({
                document: await grab(),
                fileName: msg.documentMessage.fileName || 'restored.file',
                mimetype: msg.documentMessage.mimetype || 'application/octet-stream',
                caption: `${msg.documentMessage.caption || ''}${footer}\n${note}`.trim()
            });
        }

        return send({ text: `${DELETED_MARK}\n${note}\n❌ Original content could not be recovered (expired or unsupported type).` });
    } catch (err) {
        console.error('❌ Restore error:', err.message);
        try {
            return send({ text: `${DELETED_MARK}\n${note}\n❌ Media could not be recovered.` });
        } catch {}
    }
};

function patchSource(source) {
    let code = String(source);

    // Route the chatbot through Gemini instead of an external server.
    const chatbotCall = /const apiUrl\s*=\s*`https:\/\/eliteprotech-apis\.zone\.id\/deepai[\s\S]*?const botReply\s*=[^\n]*\n/;
    if (chatbotCall.test(code)) {
        code = code.replace(chatbotCall, 'const botReply = await global.geminiChat(basePrompt, text)\n');
    } else {
        console.log('⚠️ Chatbot Gemini patch target not found.');
    }

    // Human-like persona prompt (name is configurable with .chatbotname).
    const promptBlock = /const basePrompt=`[\s\S]*?`\.trim\(\)/;
    if (promptBlock.test(code)) {
        code = code.replace(promptBlock, 'const basePrompt=global.buildChatbotPrompt(history, mek.pushName, sender)');
    } else {
        console.log('⚠️ Chatbot persona patch target not found.');
    }

    // Anti-delete: render the original content with the deleted mark inside
    // the same bubble, and deliver it to the chat it happened in
    // (groups and individual chats alike).
    const restoreSig = 'async function restoreMessage(EliteProTech, from, note, msg, quoted, mentions) {';
    if (code.includes(restoreSig)) {
        code = code.replace(
            restoreSig,
            `${restoreSig}\n    return global.restoreDeletedMessage(EliteProTech, from, note, msg, quoted, mentions)\n}\nasync function legacyRestoreMessage(EliteProTech, from, note, msg, quoted, mentions) {`
        );
    } else {
        console.log('⚠️ Anti-delete restore patch target not found.');
    }

    if (code.includes('const from = ownerNumber')) {
        code = code.split('const from = ownerNumber').join('const from = remoteJid || ownerNumber');
    } else {
        console.log('⚠️ Anti-delete target-chat patch not found.');
    }

    code = code.split('╭━━[ *× ANTI DELETE MESSAGES ×* ]━┉')
        .join('╭━━[ *× ANTI DELETE MESSAGES ×* ]━┉');

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
