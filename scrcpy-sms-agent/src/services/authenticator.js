const { adb, dumpUi, listDevices, parseNodes, shell, withSerial } = require('../lib/adb');
const { getConfig } = require('../lib/config');

const AUTH_PACKAGE = 'com.google.android.apps.authenticator2';
const TOTP_PERIOD_SEC = 30;
const MIN_REMAINING_SEC = 18;

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

function normalizeTotp(text) {
    const digits = decode(text).replace(/\s+/g, '');
    return /^\d{6,8}$/.test(digits) ? digits : null;
}

function totpRemainingSeconds(period = TOTP_PERIOD_SEC) {
    return period - (Math.floor(Date.now() / 1000) % period);
}

async function waitForFreshTotp(minRemaining = MIN_REMAINING_SEC) {
    const left = totpRemainingSeconds();
    if (left >= minRemaining) {
        return left;
    }
    await sleep(left * 1000 + 900);
    return totpRemainingSeconds();
}

function parseAccounts(nodes) {
    const names = nodes.filter((n) => idOf(n).endsWith('otp_name'));
    const accounts = [];
    for (const nameNode of names) {
        const y = nameNode.boundsBox ? nameNode.boundsBox.y : 0;
        const nearby = nodes.filter((n) => n.boundsBox && Math.abs(n.boundsBox.y - y) < 180);
        const codeNode = nearby
            .filter((n) => idOf(n).endsWith('otp_code') && n.boundsBox && n.boundsBox.y >= y - 20)
            .sort((a, b) => a.boundsBox.y - b.boundsBox.y)[0];
        const from = decode(nameNode.text);
        const raw = decode(codeNode && codeNode.text);
        const code = normalizeTotp(raw);
        if (!from) {
            continue;
        }
        accounts.push({
            from,
            body: from,
            time: 'now',
            source: 'authenticator',
            code,
            tap: nameNode.boundsBox,
        });
    }
    return accounts;
}

function pickAccount(accounts, account) {
    const needle = String(account || '').trim().toLowerCase();
    if (needle) {
        return accounts.find((item) => item.from.toLowerCase().includes(needle)) || null;
    }
    return accounts.find((item) => item.code) || accounts[0] || null;
}

async function openAuthenticator(serial) {
    const device = await pickDevice(serial);
    await shell(device.serial, 'input keyevent KEYCODE_WAKEUP');
    await adb(
        withSerial(
            ['shell', 'monkey', '-p', AUTH_PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1'],
            device.serial,
        ),
    );
    await sleep(2000);
    return { ok: true, package: AUTH_PACKAGE, device };
}

async function dumpAccounts(serial) {
    const xml = await dumpUi(serial);
    return parseAccounts(parseNodes(xml));
}

async function findAccountOnScreen(serial, account) {
    for (let pass = 0; pass < 8; pass++) {
        const batch = await dumpAccounts(serial);
        const match = pickAccount(batch, account);
        if (match) {
            return match;
        }
        await shell(serial, 'input swipe 540 1900 540 700 280');
        await sleep(450);
    }
    throw new Error(account ? 'Authenticator account not visible: ' + account : 'No Authenticator accounts were visible.');
}

async function waitForVisibleCodeChange(serial, account, previousCode) {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
        await sleep(800);
        const latest = pickAccount(await dumpAccounts(serial), account);
        if (latest && latest.code && latest.code !== previousCode) {
            return latest;
        }
    }
    throw new Error('Authenticator code did not rotate on screen in time.');
}

async function readFreshAccount(serial, account) {
    const previous = await findAccountOnScreen(serial, account);
    if (!previous || !previous.code) {
        throw new Error('Google Authenticator account is visible, but no TOTP code was shown.');
    }
    const latest = await waitForVisibleCodeChange(serial, account, previous.code);
    latest.remainingSeconds = totpRemainingSeconds();
    latest.body = latest.from + ' code ' + latest.code;
    latest.time = latest.remainingSeconds + 's left';
    return latest;
}

async function collectAuthenticatorCodes(options = {}) {
    const opened = await openAuthenticator(options.serial);
    const needles = (options.accounts || []).map((name) => String(name || '').trim().toLowerCase()).filter(Boolean);
    const found = new Map();
    for (let pass = 0; pass < 10 && (needles.length === 0 || found.size < needles.length); pass++) {
        const batch = await dumpAccounts(opened.device.serial);
        for (const item of batch) {
            const key = item.from.toLowerCase();
            const wanted = !needles.length || needles.some((needle) => key.includes(needle));
            if (wanted && item.code && !found.has(key)) {
                found.set(key, {
                    device: opened.device,
                    package: AUTH_PACKAGE,
                    source: 'authenticator',
                    from: item.from,
                    body: item.from,
                    code: item.code,
                    remainingSeconds: totpRemainingSeconds(),
                    time: totpRemainingSeconds() + 's left',
                });
            }
        }
        if (needles.length && found.size >= needles.length) {
            break;
        }
        await shell(opened.device.serial, 'input swipe 540 1900 540 700 280');
        await sleep(450);
    }
    return Array.from(found.values());
}

async function getLatestAuthenticator(options = {}) {
    const opened = await openAuthenticator(options.serial);
    const saved = getConfig();
    const account = options.account || saved.authenticatorAccount || process.env.SMS_AUTHENTICATOR_ACCOUNT;
    const wait = options.waitForChange !== false;
    const latest = wait
        ? await readFreshAccount(opened.device.serial, account)
        : await findAccountOnScreen(opened.device.serial, account);
    if (!latest || !latest.code) {
        throw new Error('Google Authenticator account is visible, but no TOTP code was shown.');
    }
    latest.remainingSeconds = totpRemainingSeconds();
    latest.body = latest.from + ' code ' + latest.code;
    latest.time = latest.remainingSeconds + 's left';
    return {
        device: opened.device,
        package: AUTH_PACKAGE,
        source: 'authenticator',
        from: latest.from,
        time: latest.time,
        body: latest.body,
        code: latest.code,
        remainingSeconds: latest.remainingSeconds,
        range: 'totp',
        conversations: [latest],
    };
}

module.exports = {
    getLatestAuthenticator,
    collectAuthenticatorCodes,
    openAuthenticator,
    totpRemainingSeconds,
    waitForFreshTotp,
};
