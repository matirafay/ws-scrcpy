const { adb, dumpUi, listDevices, parseNodes, shell, withSerial } = require('./adb');
const { extractCode, filterToday, pickMessage } = require('./sms');

const RC_PACKAGE = 'com.glip.mobile';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pickDevice(serial) {
    const devices = await listDevices();
    const ready = devices.filter((d) => d.state === 'device');
    if (!ready.length) {
        throw new Error('No authorized phone found.');
    }
    if (serial) {
        const match = ready.find((d) => d.serial === serial);
        if (!match) {
            throw new Error('Device ' + serial + ' is not ready.');
        }
        return match;
    }
    return ready[0];
}

function decode(text) {
    return String(text || '')
        .replace(/&amp;/g, '&')
        .replace(/&#10;/g, '\n')
        .trim();
}

function idOf(node) {
    return String((node && node['resource-id']) || '');
}

function parseRcConversations(nodes) {
    const names = nodes.filter((n) => idOf(n).endsWith('conversation_item_display_name_view'));
    const conversations = [];
    for (const nameNode of names) {
        const y = nameNode.boundsBox ? nameNode.boundsBox.y : 0;
        const nearby = nodes.filter((n) => n.boundsBox && Math.abs(n.boundsBox.y - y) < 120);
        const preview = nearby.find((n) => idOf(n).endsWith('conversation_item_preview_view'));
        const timeNode = nearby.find((n) => idOf(n).endsWith('conversation_item_time_view'));
        const unread = nearby.find((n) => idOf(n).endsWith('conversation_item_unread_count_view'));
        conversations.push({
            from: decode(nameNode.text),
            body: decode(preview && preview.text),
            time: decode(timeNode && timeNode.text),
            unread: decode(unread && unread.text) || null,
            source: 'ringcentral',
            code: extractCode(decode(preview && preview.text)),
            tap: nameNode.boundsBox,
        });
    }
    return conversations.filter((item) => item.from);
}

async function tapTextTab(serial) {
    const xml = await dumpUi(serial);
    const nodes = parseNodes(xml);
    const tab = nodes.find((n) => decode(n.text) === 'Text' && idOf(n).endsWith(':id/title'));
    const fallback = nodes.find((n) => decode(n['content-desc']) === 'Text' || decode(n.text) === 'Text');
    const target = tab || fallback;
    if (target && target.boundsBox) {
        await shell(serial, 'input tap ' + target.boundsBox.x + ' ' + target.boundsBox.y);
        await sleep(1200);
    }
}

async function openRingCentral(serial) {
    const device = await pickDevice(serial);
    await shell(device.serial, 'input keyevent KEYCODE_WAKEUP');
    await adb(withSerial(['shell', 'am', 'force-stop', 'com.google.android.apps.messaging'], device.serial));
    await adb(
        withSerial(
            ['shell', 'monkey', '-p', RC_PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1'],
            device.serial,
        ),
    );
    await sleep(2500);
    await tapTextTab(device.serial);
    return { ok: true, package: RC_PACKAGE, device };
}

async function readRingCentralUi(serial) {
    const device = await pickDevice(serial);
    const xml = await dumpUi(device.serial);
    return {
        device,
        conversations: parseRcConversations(parseNodes(xml)),
    };
}

async function getLatestRingCentral(options = {}) {
    const opened = await openRingCentral(options.serial);
    const ui = await readRingCentralUi(opened.device.serial);
    let conversations = ui.conversations;
    const todayOnly = options.lastDay !== false && options.today !== false;
    if (todayOnly) {
        conversations = filterToday(conversations);
    }
    const latest = pickMessage(conversations, Boolean(options.verificationOnly));
    if (!latest) {
        throw new Error(
            todayOnly
                ? 'No RingCentral texts from today were visible.'
                : 'RingCentral opened, but no texts were visible.',
        );
    }
    return {
        device: opened.device,
        package: RC_PACKAGE,
        source: 'ringcentral',
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
    getLatestRingCentral,
    openRingCentral,
    readRingCentralUi,
};
