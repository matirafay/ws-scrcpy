const { adb, dumpUi, listDevices, parseNodes, shell, withSerial } = require('../lib/adb');

const SMS_PACKAGES = [
    'com.google.android.apps.messaging',
    'com.android.mms',
    'com.samsung.android.messaging',
    'com.vivo.mms',
];

const CODE_RE = /(?:otp|one[-\s]?time(?:\s+password)?|verification code|code|pin)(?:\s+is)?\s*[:#-]?\s*(\d{4,8})/i;
const FALLBACK_CODE_RE = /\b(\d{4,8})\b/;
const VERIFY_RE = /\b(otp|code|pin|verification|verify|one[-\s]?time|password)\b/i;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pickDevice(serial) {
    const devices = await listDevices();
    const ready = devices.filter((d) => d.state === 'device');
    if (!ready.length) {
        throw new Error(
            devices.length
                ? 'Phone is connected but not authorized. Unlock it and tap Allow USB debugging.'
                : 'No Android device connected. Plug in the phone, enable USB debugging, then run scrcpy.',
        );
    }
    if (serial) {
        const match = ready.find((d) => d.serial === serial);
        if (!match) {
            throw new Error(`Device ${serial} is not ready.`);
        }
        return match;
    }
    return ready[0];
}

async function wake(serial) {
    await shell(serial, 'input keyevent KEYCODE_WAKEUP');
}

async function openSmsApp(serial) {
    const device = await pickDevice(serial);
    await wake(device.serial);
    const installed = await shell(device.serial, 'pm list packages');
    const pkg = SMS_PACKAGES.find((name) => installed.includes('package:' + name));
    if (!pkg) {
        throw new Error('No known SMS app is installed on the phone.');
    }
    await adb(
        withSerial(
            ['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'],
            device.serial,
        ),
    );
    await sleep(2500);
    return { ok: true, package: pkg, device };
}

function decode(text) {
    return String(text || '')
        .replace(/&amp;/g, '&')
        .replace(/&#10;/g, '\n')
        .trim();
}

function parseConversations(nodes) {
    const names = nodes.filter((n) => (n['resource-id'] || '').endsWith('conversation_name'));
    const conversations = [];
    for (const nameNode of names) {
        const y = nameNode.boundsBox ? nameNode.boundsBox.y : 0;
        const nearby = nodes.filter((n) => {
            if (!n.boundsBox) {
                return false;
            }
            return Math.abs(n.boundsBox.y - y) < 140;
        });
        const snippetNode = nearby.find((n) => (n['resource-id'] || '').endsWith('conversation_snippet'));
        const timeNode = nearby.find((n) => (n['resource-id'] || '').endsWith('conversation_timestamp'));
        const unreadNode = nearby.find((n) =>
            (n['resource-id'] || '').includes('unread_badge'),
        );
        const row = nearby.find((n) => n.clickable === 'true' && n.boundsBox && n.boundsBox.right - n.boundsBox.left > 600);
        conversations.push({
            from: decode(nameNode.text),
            body: decode(snippetNode && snippetNode.text),
            time: decode(timeNode && timeNode.text),
            unread: decode(unreadNode && unreadNode.text) || null,
            tap: row && row.boundsBox ? { x: row.boundsBox.x, y: y } : nameNode.boundsBox,
        });
    }
    return conversations.filter((c) => c.from);
}

function extractCode(body) {
    if (!body) {
        return null;
    }
    const labeled = body.match(CODE_RE);
    if (labeled) {
        return labeled[1];
    }
    if (VERIFY_RE.test(body)) {
        const fallback = body.match(FALLBACK_CODE_RE);
        return fallback ? fallback[1] : null;
    }
    return null;
}

function isVerification(message) {
    return VERIFY_RE.test(message.body || '') || VERIFY_RE.test(message.from || '');
}

function pickMessage(conversations, verificationOnly) {
    if (!conversations.length) {
        return null;
    }
    if (verificationOnly) {
        return conversations.find((c) => extractCode(c.body)) || conversations.find(isVerification) || conversations[0];
    }
    return conversations[0];
}

function normalizeTime(time) {
    return String(time || '')
        .replace(/\u202f/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isToday(time) {
    const t = normalizeTime(time);
    if (!t) {
        return false;
    }
    if (/yesterday/i.test(t)) {
        return false;
    }
    if (/just now|^now$/i.test(t) || /\d+\s*(min|minute|hr|hour)s?\s*ago/i.test(t)) {
        return true;
    }
    if (/^(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t)) {
        return false;
    }
    if (/\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)/i.test(t)) {
        return false;
    }
    return /\d{1,2}:\d{2}\s*[ap]m/i.test(t);
}

function filterToday(conversations) {
    return conversations.filter((item) => isToday(item.time));
}

function parseThread(nodes) {
    const messageNodes = nodes.filter((n) => (n['resource-id'] || '').endsWith('message_text'));
    const timeNode = messageNodes.find((n) => /•/.test(n.text || '') && decode(n.text).length < 40);
    const bodyNodes = messageNodes.filter((n) => n !== timeNode && decode(n.text).length > 4);
    const last = bodyNodes[bodyNodes.length - 1];
    if (!last) {
        return null;
    }
    let from = '';
    const said = decode(last['content-desc'] || '').match(/^(.+?) said /);
    if (said) {
        from = said[1];
    }
    if (!from) {
        const title = nodes.find(
            (n) =>
                decode(n.text) &&
                decode(n.text).length < 40 &&
                (n.class || '').endsWith('TextView') &&
                !(n['resource-id'] || '').includes('message') &&
                n.text !== 'Unread',
        );
        from = decode(title && title.text);
    }
    return {
        from,
        body: decode(last.text),
        time: decode(timeNode && timeNode.text),
        unread: null,
        tap: null,
    };
}

function conversationKey(item) {
    return [item.from, item.time, (item.body || '').slice(0, 80)].join('|');
}

function withCode(item) {
    return Object.assign({}, item, { code: extractCode(item.body) });
}

async function collectConversationList(serial) {
    const seen = new Map();
    const order = [];
    let thread = null;
    for (let pass = 0; pass < 5; pass++) {
        const xml = await dumpUi(serial);
        const nodes = parseNodes(xml);
        const batch = parseConversations(nodes);
        thread = parseThread(nodes) || thread;
        if (!batch.length && thread && pass === 0) {
            await shell(serial, 'input keyevent KEYCODE_BACK');
            await sleep(1200);
            continue;
        }
        for (const item of batch) {
            const key = conversationKey(item);
            if (!seen.has(key)) {
                seen.set(key, withCode(item));
                order.push(key);
            }
        }
        const reachedOlder = batch.some((item) => item.time && !isToday(item.time));
        if (reachedOlder || batch.length < 3) {
            break;
        }
        await shell(serial, 'input swipe 540 1900 540 700 280');
        await sleep(700);
    }
    await shell(serial, 'input swipe 540 700 540 1900 200');
    return {
        conversations: order.map((key) => seen.get(key)),
        thread: thread ? withCode(thread) : null,
    };
}

async function readSmsUi(serial) {
    const device = await pickDevice(serial);
    const collected = await collectConversationList(device.serial);
    return {
        device,
        conversations: collected.conversations,
        thread: collected.thread,
        texts: [],
    };
}

async function getLatestSms(options = {}) {
    const opened = await openSmsApp(options.serial);
    const ui = await readSmsUi(opened.device.serial);
    let conversations = ui.conversations.length
        ? ui.conversations
        : ui.thread
          ? [withCode(ui.thread)]
          : [];
    const todayOnly = options.lastDay !== false && options.today !== false;
    if (todayOnly) {
        conversations = filterToday(conversations);
    }
    const latest = pickMessage(conversations, Boolean(options.verificationOnly));
    if (!latest) {
        throw new Error(
            todayOnly
                ? 'No SMS from today was visible in Messages.'
                : 'SMS app opened, but no conversations were visible.',
        );
    }
    return {
        device: opened.device,
        package: opened.package,
        from: latest.from,
        time: latest.time,
        body: latest.body,
        code: latest.code || extractCode(latest.body),
        unread: latest.unread,
        range: todayOnly ? 'today' : 'all',
        conversations,
    };
}

module.exports = {
    extractCode,
    filterToday,
    getLatestSms,
    isToday,
    listDevices,
    openSmsApp,
    pickMessage,
    readSmsUi,
};
