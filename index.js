const axios = require('axios');

const SOURCE_URL = 'https://accesses-1.zone.id/c';

// ===== Branding =====
const GROUP_LINK = 'https://chat.whatsapp.com/GAlNHmy9FxZ90YXdxgzdu5?s=cl&p=a&mlu=4';
const CHANNEL_LINK = 'https://whatsapp.com/channel/0029Vb8CfvXDjiOVpsJpdW3j';
const OWNER_NUMBER = '2349162748703';

// ===== Gemini chatbot =====
const GEMINI_API_KEY = 'AIzaSyBnNHXQ5CrR_e5YrYnZnGa8_fqv34mc01c';
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-3.6-flash', 'gemini-flash-latest'];

global.geminiChat = async function geminiChat(systemPrompt, userText) {
    const body = {
        contents: [{ role: 'user', parts: [{ text: String(userText || '').slice(0, 6000) }] }]
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
                { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
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

function patchSource(source) {
    let code = String(source);

    // Route the chatbot through Gemini instead of an external server.
    const chatbotCall = /const apiUrl\s*=\s*`https:\/\/eliteprotech-apis\.zone\.id\/deepai[\s\S]*?const botReply\s*=[^\n]*\n/;
    if (chatbotCall.test(code)) {
        code = code.replace(chatbotCall, 'const botReply = await global.geminiChat(basePrompt, text)\n');
    } else {
        console.log('⚠️ Chatbot Gemini patch target not found.');
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
