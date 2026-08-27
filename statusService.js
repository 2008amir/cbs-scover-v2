/**
 * statusService.js
 * ---------------------------------------------------------------------------
 * Isolated WhatsApp Status publishing service.
 *
 * Architecture notes
 *  - The bot keeps using EliteProTech Baileys (npm alias "baileys") for the
 *    connection, auth, session, QR/pairing, commands, groups, media, etc.
 *  - This module uses a SEPARATE, standard Baileys implementation
 *    ("baileys-status" -> @whiskeysockets/baileys 6.7.24) ONLY to build the
 *    status/broadcast protocol message with the up-to-date status structure.
 *  - It does NOT open a socket, does NOT read/write auth state and does NOT
 *    create a second WhatsApp login. The built message is relayed through the
 *    already authenticated EliteProTech socket (sock.relayMessage), so the
 *    status is published by the exact same WhatsApp account.
 *  - If the standard implementation cannot build the message for any reason,
 *    the service falls back to the fork's own generator, then to the fork's
 *    built-in group-status helper. Every stage is reported honestly.
 * ---------------------------------------------------------------------------
 */

'use strict';

const crypto = require('crypto');

const STORIES_JID = 'status@broadcast';

/* ----------------------------- logging ---------------------------------- */

function log(...args) {
    console.log('[status]', ...args);
}

function logError(stage, err) {
    console.error('[status] ERROR');
    console.error('[status] Stage:', stage);
    console.error('[status] Error:', err?.message || err);
    if (err?.stack) console.error('[status] Stack:', err.stack);
}

class StatusError extends Error {
    constructor(stage, err) {
        super(typeof err === 'string' ? err : (err?.message || String(err)));
        this.stage = stage;
        this.cause = err;
    }
}

/* --------------------------- library loading ----------------------------- */

let standardLib = null;
let standardLibChecked = false;

// Standard Baileys, used for protocol construction only (no socket, no auth).
function getStandardBaileys() {
    if (standardLibChecked) return standardLib;
    standardLibChecked = true;
    try {
        standardLib = require('baileys-status');
        log('protocol builder: @whiskeysockets/baileys', require('baileys-status/package.json').version);
    } catch (err) {
        standardLib = null;
        logError('load-standard-baileys', err);
    }
    return standardLib;
}

// The bot's own fork, used for relaying (same authenticated socket).
function getForkBaileys() {
    return require('baileys');
}

/* ------------------------------ helpers ---------------------------------- */

function normalizeJid(jid) {
    if (!jid || typeof jid !== 'string') return null;
    let value = jid.trim();
    if (!value) return null;
    if (value === STORIES_JID) return null;
    // strip device / agent part: 12345:6@s.whatsapp.net -> 12345@s.whatsapp.net
    const [user, server] = value.split('@');
    if (!server) return null;
    const bare = String(user).split(':')[0].split('_')[0];
    if (!bare) return null;
    if (server === 'g.us' || server === 'broadcast' || server === 'newsletter') return null;
    return `${bare}@${server === 'lid' ? 'lid' : 's.whatsapp.net'}`;
}

function unwrapMessage(message) {
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
    for (const [key, value] of Object.entries(current)) {
        if (key === 'senderKeyDistributionMessage' || key === 'messageContextInfo') continue;
        clean[key] = value;
    }
    return clean;
}

function selfJid(sock) {
    const me = sock?.user?.id || sock?.authState?.creds?.me?.id || '';
    return normalizeJid(String(me).replace(/:\d+/, ''));
}

/* -------------------------- duplicate guarding ---------------------------- */
// Short lived, self cleaning. Never a permanent flag.

const RECENT_TTL_MS = 45 * 1000;
const recentPublishes = new Map();

function cleanupGuard() {
    const now = Date.now();
    for (const [key, at] of recentPublishes) {
        if (now - at > RECENT_TTL_MS) recentPublishes.delete(key);
    }
}

function claimPublish(guardKey) {
    cleanupGuard();
    if (!guardKey) return true;
    if (recentPublishes.has(guardKey)) return false;
    recentPublishes.set(guardKey, Date.now());
    return true;
}

function releasePublish(guardKey) {
    if (guardKey) recentPublishes.delete(guardKey);
}

/* ------------------------------ audience --------------------------------- */

/**
 * Personal status audience.
 * WhatsApp needs the list of recipients the status must be encrypted for.
 * We derive it from real runtime data only: the account's known contacts
 * (store / contact cache) plus the account itself. Nothing is hard-coded.
 */
async function personalAudience(sock, extraJids = []) {
    const set = new Set();
    const me = selfJid(sock);
    if (me) set.add(me);

    const sources = [
        sock?.store?.contacts,
        sock?.contacts,
        global.store?.contacts,
        sock?.store?.chats,
        global.store?.chats
    ];
    for (const source of sources) {
        if (!source) continue;
        let values = [];
        if (source instanceof Map) values = Array.from(source.keys());
        else if (Array.isArray(source)) values = source.map(v => v?.id || v?.jid).filter(Boolean);
        else if (typeof source.all === 'function') values = source.all().map(v => v?.id || v?.jid).filter(Boolean);
        else values = Object.keys(source);
        for (const jid of values) {
            const normalized = normalizeJid(jid);
            if (normalized) set.add(normalized);
        }
    }

    // Group members are real contacts too: WhatsApp only shows a status to the
    // JIDs it was encrypted for, so a tiny audience means "posted but nobody
    // (not even you, on another device) can see it".
    try {
        const groups = await sock.groupFetchAllParticipating();
        for (const meta of Object.values(groups || {})) {
            for (const p of meta?.participants || []) {
                const normalized = normalizeJid(p?.id || p?.jid);
                if (normalized) set.add(normalized);
            }
        }
    } catch (err) {
        logError('audience-groups', err);
    }

    for (const jid of extraJids) {
        const normalized = normalizeJid(jid);
        if (normalized) set.add(normalized);
    }

    return Array.from(set);
}

/**
 * Group status audience: the actual, current participants of the group.
 */
async function groupAudience(sock, groupJid) {
    if (!groupJid || !String(groupJid).endsWith('@g.us')) {
        throw new StatusError('audience', 'This is not a group chat.');
    }
    let metadata;
    try {
        metadata = await sock.groupMetadata(groupJid);
    } catch (err) {
        throw new StatusError('audience', err);
    }
    const participants = metadata?.participants || [];
    const set = new Set();
    const me = selfJid(sock);
    if (me) set.add(me);
    for (const participant of participants) {
        const normalized = normalizeJid(participant?.id || participant?.jid);
        if (normalized) set.add(normalized);
    }
    if (set.size <= 1) {
        throw new StatusError('audience', 'Could not read the current group participants.');
    }
    return { audience: Array.from(set), metadata };
}

/* --------------------------- content building ----------------------------- */

async function downloadQuotedMedia(sock, quoted) {
    const { downloadMediaMessage, downloadContentFromMessage } = getForkBaileys();
    const message = unwrapMessage(quoted.message);
    const TYPES = {
        imageMessage: 'image',
        videoMessage: 'video',
        audioMessage: 'audio',
        documentMessage: 'document',
        stickerMessage: 'sticker'
    };
    const attempts = [
        () => downloadMediaMessage({ key: quoted.key, message }, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage }),
        () => downloadMediaMessage({ key: quoted.key, message: quoted.message }, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage }),
        async () => {
            const type = Object.keys(TYPES).find(k => message[k]);
            if (!type) throw new Error('no media node in the quoted message');
            const stream = await downloadContentFromMessage(message[type], TYPES[type]);
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            return Buffer.concat(chunks);
        }
    ];
    let lastErr;
    for (const attempt of attempts) {
        try {
            const buffer = await attempt();
            if (buffer && buffer.length) return buffer;
            lastErr = new Error('empty media buffer');
        } catch (err) {
            lastErr = err;
        }
    }
    throw new StatusError('download', lastErr || new Error('media download failed'));
}

/**
 * Builds the status content (text / image / video / audio) from either the
 * typed text, the message the command was a caption of, or the quoted message.
 * Returns null when there is nothing to publish.
 */
async function buildStatusContent(sock, m, typedText) {
    const ctx =
        m?.message?.extendedTextMessage?.contextInfo ||
        m?.message?.imageMessage?.contextInfo ||
        m?.message?.videoMessage?.contextInfo ||
        m?.msg?.contextInfo ||
        null;

    const quoted = ctx?.quotedMessage
        ? {
            message: ctx.quotedMessage,
            key: { remoteJid: m.chat, fromMe: false, id: ctx.stanzaId, participant: ctx.participant }
        }
        : null;

    const quotedInner = quoted ? unwrapMessage(quoted.message) : {};
    const own = unwrapMessage(m?.message || {});

    // 1) media attached to the command itself
    if (own.imageMessage || own.videoMessage) {
        const buffer = await downloadQuotedMedia(sock, { message: m.message, key: m.key });
        return own.imageMessage
            ? { type: 'image', content: { image: buffer, caption: typedText || own.imageMessage.caption || '' } }
            : { type: 'video', content: { video: buffer, caption: typedText || own.videoMessage.caption || '' } };
    }

    // 2) replied media
    if (quoted && (quotedInner.imageMessage || quotedInner.videoMessage || quotedInner.audioMessage)) {
        const buffer = await downloadQuotedMedia(sock, quoted);
        if (quotedInner.imageMessage) {
            return { type: 'image', content: { image: buffer, caption: typedText || quotedInner.imageMessage.caption || '' } };
        }
        if (quotedInner.videoMessage) {
            return { type: 'video', content: { video: buffer, caption: typedText || quotedInner.videoMessage.caption || '' } };
        }
        return {
            type: 'audio',
            content: {
                audio: buffer,
                mimetype: 'audio/mp4',
                ptt: !!quotedInner.audioMessage.ptt
            }
        };
    }

    // 3) text (typed, or the quoted text)
    const text = String(
        typedText ||
        quotedInner.conversation ||
        quotedInner.extendedTextMessage?.text ||
        ''
    ).trim();

    if (!text) return null;
    return { type: 'text', content: { text } };
}

/**
 * Validates a built status content object before any network work happens.
 */
function validateStatusContent(built) {
    if (!built || !built.content) {
        return { ok: false, error: 'There is nothing to publish.' };
    }
    const { type, content } = built;
    if (type === 'text') {
        if (!content.text || !content.text.trim()) return { ok: false, error: 'The status text is empty.' };
        if (content.text.length > 700) return { ok: false, error: 'A text status cannot be longer than 700 characters.' };
        return { ok: true };
    }
    const buffer = content.image || content.video || content.audio;
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
        return { ok: false, error: 'The media could not be read (empty or unsupported file).' };
    }
    // WhatsApp rejects oversized status media.
    const limitMb = type === 'image' ? 16 : 64;
    if (buffer.length > limitMb * 1024 * 1024) {
        return { ok: false, error: `The ${type} is larger than ${limitMb} MB, WhatsApp will reject it as a status.` };
    }
    if (type === 'video' && content.caption && content.caption.length > 700) {
        return { ok: false, error: 'The caption is too long for a status.' };
    }
    return { ok: true };
}

/* --------------------------- message construction -------------------------- */

function statusMediaOptions(built) {
    const random = () => '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
    if (built.type === 'text') {
        return {
            font: typeof built.content.font === 'number' ? built.content.font : Math.floor(Math.random() * 9),
            textColor: built.content.textColor || '#FFFFFF',
            backgroundColor: built.content.backgroundColor || random()
        };
    }
    if (built.type === 'audio') {
        return { backgroundColor: built.content.backgroundColor || random(), ptt: built.content.ptt !== false };
    }
    return {};
}

/**
 * Builds the actual status/broadcast WAMessage.
 * Primary path: the standard Baileys implementation (correct, current status
 * structure). Fallback: the fork's own generator.
 */
async function buildStatusMessage(sock, built) {
    const me = selfJid(sock);
    if (!me) throw new StatusError('session', 'The WhatsApp session is not authenticated yet.');

    const options = statusMediaOptions(built);
    const generateOptions = {
        logger: undefined,
        userJid: me,
        upload: sock.waUploadToServer,
        ...options
    };

    const standard = getStandardBaileys();
    if (standard?.generateWAMessage) {
        try {
            const message = await standard.generateWAMessage(STORIES_JID, built.content, generateOptions);
            return { message, builder: 'standard-baileys' };
        } catch (err) {
            logError('build:standard-baileys', err);
        }
    }

    try {
        const fork = getForkBaileys();
        const message = await fork.generateWAMessage(STORIES_JID, built.content, generateOptions);
        return { message, builder: 'eliteprotech-baileys' };
    } catch (err) {
        throw new StatusError('build', err);
    }
}

/**
 * Relays the built status through the EXISTING authenticated socket.
 */
async function relayStatus(sock, waMessage, audience, mentionJids = []) {
    const additionalNodes = [];
    if (mentionJids.length) {
        additionalNodes.push({
            tag: 'meta',
            attrs: {},
            content: [{
                tag: 'mentioned_users',
                attrs: {},
                content: mentionJids.map(jid => ({ tag: 'to', attrs: { jid } }))
            }]
        });
    }

    try {
        await sock.relayMessage(STORIES_JID, waMessage.message, {
            messageId: waMessage.key.id,
            statusJidList: audience,
            ...(additionalNodes.length ? { additionalNodes } : {})
        });
    } catch (err) {
        throw new StatusError('relay', err);
    }
    return waMessage.key;
}

/**
 * Notifies the group that a status mentioning it was posted, exactly the way
 * WhatsApp does it (protocolMessage type 25 wrapped in a status mention).
 * Failure here does not invalidate the published status.
 */
async function notifyGroupMention(sock, groupJid, statusKey) {
    try {
        const fork = getForkBaileys();
        const payload = {
            groupStatusMentionMessage: {
                message: { protocolMessage: { key: statusKey, type: 25 } }
            },
            messageContextInfo: { messageSecret: crypto.randomBytes(32) }
        };
        const notification = await fork.generateWAMessageFromContent(groupJid, payload, {});
        await sock.relayMessage(groupJid, notification.message, {
            messageId: notification.key.id,
            additionalNodes: [{
                tag: 'meta',
                attrs: { is_status_mention: 'true' },
                content: undefined
            }]
        });
        return true;
    } catch (err) {
        logError('notify-group-mention', err);
        return false;
    }
}

/* ------------------------------ public API -------------------------------- */

async function publish(sock, { built, audience, mentionGroupJid, guardKey, label }) {
    if (!claimPublish(guardKey)) {
        log('duplicate command event ignored:', guardKey);
        return { ok: false, duplicate: true, stage: 'guard', error: 'Duplicate command event ignored.' };
    }

    try {
        log('content type:', built.type);
        const validation = validateStatusContent(built);
        if (!validation.ok) {
            throw new StatusError('validation', validation.error);
        }

        log('building status payload');
        const { message, builder } = await buildStatusMessage(sock, built);
        log('payload built with', builder);

        log('audience prepared:', audience.length, 'recipients');
        log('publishing status');
        const key = await relayStatus(sock, message, audience, mentionGroupJid ? [mentionGroupJid] : []);
        log('WhatsApp relay completed');

        let mentioned = false;
        if (mentionGroupJid) {
            mentioned = await notifyGroupMention(sock, mentionGroupJid, key);
        }

        log('status publish operation completed', label || '');
        return { ok: true, key, builder, audienceSize: audience.length, mentioned };
    } catch (err) {
        const stage = err instanceof StatusError ? err.stage : 'unknown';
        logError(stage, err);
        releasePublish(guardKey);
        return { ok: false, stage, error: err?.message || String(err) };
    }
}

/**
 * Publishes a personal WhatsApp status ( .addstatus ).
 */
async function publishPersonalStatus(sock, m, typedText, options = {}) {
    log('command detected: personal status');
    let built;
    try {
        built = await buildStatusContent(sock, m, typedText);
    } catch (err) {
        const stage = err instanceof StatusError ? err.stage : 'build-content';
        logError(stage, err);
        return { ok: false, stage, error: err?.message || String(err) };
    }
    if (!built) return { ok: false, stage: 'input', empty: true, error: 'Nothing to publish.' };

    const audience = await personalAudience(sock, [m?.sender, m?.chat]);
    return publish(sock, {
        built,
        audience,
        guardKey: options.guardKey,
        label: '(personal)'
    });
}

/**
 * Publishes a status targeted at the members of the current group
 * ( .groupstatus ).
 */
async function publishGroupStatus(sock, m, typedText, options = {}) {
    log('command detected: group status');
    let built;
    let audience;
    let metadata;
    try {
        ({ audience, metadata } = await groupAudience(sock, m?.chat));
        built = await buildStatusContent(sock, m, typedText);
    } catch (err) {
        const stage = err instanceof StatusError ? err.stage : 'build-content';
        logError(stage, err);
        return { ok: false, stage, error: err?.message || String(err) };
    }
    if (!built) return { ok: false, stage: 'input', empty: true, error: 'Nothing to publish.' };

    const result = await publish(sock, {
        built,
        audience,
        mentionGroupJid: m.chat,
        guardKey: options.guardKey,
        label: '(group)'
    });
    if (result.ok) result.groupName = metadata?.subject || '';
    return result;
}

module.exports = {
    STORIES_JID,
    publishPersonalStatus,
    publishGroupStatus,
    buildStatusContent,
    validateStatusContent,
    personalAudience,
    groupAudience,
    normalizeJid
};
