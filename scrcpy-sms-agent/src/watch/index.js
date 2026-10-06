const { recoverAdb, usbWaitMessage, ensureWirelessAdb, pickReadyDevice, isWirelessSerial, keepPhonePowered, listDevices, releaseUsbDataForCharging } = require('../lib/adb');
const { collectFortiTokenCodes, keepCodesVisible, waitForFreshWindow, totpRemainingSeconds, PREFERRED_LEFT_TO_READ, MIN_LEFT_TO_POST, ensureFortiTokenAlive } = require('../services/fortitoken');
const { pushSms } = require('../lib/push');
const { getConfig, configPath } = require('../lib/config');
const { DEFAULT_TARGETS } = require('../lib/defaults');
const { ensureScrcpyRunning, isScrcpyRunning, stopScrcpy } = require('../services/scrcpy');
const fs = require('fs');
const path = require('path');

const MIN_SECONDS_TO_SEND = MIN_LEFT_TO_POST;

function statePath() {
    return path.join(path.dirname(configPath()), 'sms-agent-state.json');
}

function loadState() {
    try {
        return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    } catch (_err) {
        return { lastSentCode: '', lastSent: {}, lastSentWindow: {}, lastSentAt: {} };
    }
}

function saveState(state) {
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

function targetsFromConfig() {
    const cfg = getConfig();
    return Array.isArray(cfg.targets) && cfg.targets.length ? cfg.targets : DEFAULT_TARGETS;
}

function matchTarget(item, target) {
    const names = [target.account].concat(Array.isArray(target.aliases) ? target.aliases : []);
    const from = String(item.from || '').toLowerCase();
    return names.some((name) => {
        const needle = String(name || '').toLowerCase();
        if (!needle) {
            return false;
        }
        if (from.includes(needle) || needle.includes(from)) {
            return true;
        }
        return (
            (from.includes('mahmood') || from.includes('mmehmood')) &&
            (needle.includes('mahmood') || needle.includes('mmehmood'))
        );
    });
}

function waitMessage(seconds) {
    return 'Please wait up to ' + seconds + ' second' + (seconds === 1 ? '' : 's') + '.';
}

async function pushNewCode(sms, state, log, target) {
    if (!sms || !sms.code || !target) {
        return false;
    }
    if (!state.lastSent) {
        state.lastSent = {};
    }
    if (!state.lastSentWindow) {
        state.lastSentWindow = {};
    }
    if (!state.lastSentAt) {
        state.lastSentAt = {};
    }
    const key = target.automationShortCode + ':' + target.title;
    const left = totpRemainingSeconds();
    const windowId = Math.floor(Date.now() / 1000 / 30);
    const enough = left >= MIN_SECONDS_TO_SEND;
    const ageMs = Date.now() - Number(state.lastSentAt[key] || 0);
    log(
        '"' +
            target.title +
            '": time remaining ' +
            left +
            's. ' +
            (enough ? 'Enough to send to the endpoint.' : 'Not enough to send. ' + waitMessage(left)),
    );
    if (state.lastSent[key] === sms.code) {
        if (!state.lastSentAt[key] || ageMs < 28000) {
            log('Already posted "' + target.title + '" this window. ' + waitMessage(left));
            return 'done';
        }
        log('Screen still shows the previous window for "' + target.title + '". Waiting for new digits.');
        return 'stale';
    }
    if (!enough) {
        return false;
    }
    const result = await pushSms(sms, {
        title: target.title,
        automationShortCode: target.automationShortCode,
    });
    state.lastSent[key] = sms.code;
    state.lastSentWindow[key] = windowId;
    state.lastSentAt[key] = Date.now();
    state.lastSentCode = sms.code;
    saveState(state);
    const reply = String((result.inbox && result.inbox.body) || '')
        .replace(/\d/g, '#')
        .slice(0, 180);
    log(
        'Posted "' +
            target.title +
            '" with ' +
            left +
            's left (HTTP ' +
            result.inbox.status +
            ' type=' +
            (result.payload && result.payload.type) +
            ' short=' +
            (result.payload && result.payload.automationShortCode) +
            (reply ? ' reply=' + reply : '') +
            '). Copy it now.',
    );
    return 'posted';
}

function startWatch(options = {}) {
    const log = options.log || ((message) => console.log(message));
    const state = loadState();
    let timer = null;
    let stopped = false;

    function msUntilNextWindow() {
        return totpRemainingSeconds() * 1000 + 450;
    }

    let lastWaitLog = '';
    let lastWaitAt = 0;
    let lastRecoverAt = Date.now();
    let lastWifiAttemptAt = 0;
    let lastTransportLog = '';
    let lastChargeAt = 0;
    let lastChargeLog = '';
    let powerBusy = false;
    let stoppedZombie = false;
    let pendingReveal = false;
    let pendingRetry = false;
    let hadReadyDevice = false;

    async function tick() {
        const now = Date.now();
        let devices = await listDevices();
        let readyDevice = pickReadyDevice(devices);
        const wifiReady = !!(readyDevice && isWirelessSerial(readyDevice.serial));
        if (!wifiReady && (!readyDevice || now - lastWifiAttemptAt > 20000)) {
            lastWifiAttemptAt = now;
            const wireless = await ensureWirelessAdb(log);
            if (wireless) {
                readyDevice = wireless;
            }
        }
        if (!readyDevice) {
            if (!stoppedZombie && isScrcpyRunning()) {
                stopScrcpy();
                stoppedZombie = true;
                log('Stopped the leftover phone mirror until debugging is available.');
            }
            if (now - lastRecoverAt > 45000) {
                lastRecoverAt = now;
                try {
                    await recoverAdb();
                    log('Restarted ADB and looking for the phone again (Wi-Fi first, USB fallback).');
                    readyDevice = await ensureWirelessAdb(log);
                } catch (err) {
                    log('ADB restart failed: ' + String((err && err.message) || err || 'unknown'));
                }
            }
            if (readyDevice) {
                stoppedZombie = false;
            } else {
                hadReadyDevice = false;
                const message = await usbWaitMessage(devices);
                if (message !== lastWaitLog || now - lastWaitAt > 20000) {
                    lastWaitLog = message;
                    lastWaitAt = now;
                    log(message);
                }
                return { posted: 0, needed: 0, retrySoon: true, waitMs: 5000 };
            }
        }
        stoppedZombie = false;
        lastWaitLog = '';
        if (!hadReadyDevice) {
            hadReadyDevice = true;
            log('Phone is back. Waking, swiping unlock, opening FortiToken.');
            try {
                await ensureFortiTokenAlive(readyDevice.serial, log);
            } catch (err) {
                log('Wake/swipe/FortiToken failed: ' + String((err && err.message) || err || 'unknown'));
            }
        }
        const transport = isWirelessSerial(readyDevice.serial) ? 'wifi' : 'usb';
        const transportLog =
            transport === 'wifi'
                ? 'Using Wi-Fi debugging: ' + readyDevice.serial
                : 'Using USB debugging as fallback: ' + readyDevice.serial;
        if (transportLog !== lastTransportLog) {
            lastTransportLog = transportLog;
            log(transportLog);
        }
        if (transport === 'wifi') {
            releaseUsbDataForCharging(log).catch(() => {});
        }
        if (!powerBusy && now - lastChargeAt > 45000) {
            lastChargeAt = now;
            powerBusy = true;
            const serial = readyDevice.serial;
            keepPhonePowered(serial)
                .then((battery) => {
                    const level = battery.level != null ? battery.level + '%' : 'unknown';
                    let chargeLog;
                    if (battery.charging) {
                        chargeLog =
                            'Phone is charging (' +
                            level +
                            '). USB cable stays connected so it does not turn off or shut down.';
                    } else if (battery.plugged || battery.usb) {
                        chargeLog =
                            'USB is plugged but the phone is NOT charging (' +
                            level +
                            '). The I15 Pro Max USB data device in Device Manager blocks charging on this phone. Releasing that device so the cable can charge.';
                    } else {
                        chargeLog =
                            'Phone is NOT charging (' +
                            level +
                            '). Plug the USB cable into a wall charger or a rear USB port so it does not turn off or shut down.';
                    }
                    if (chargeLog !== lastChargeLog || !battery.charging) {
                        lastChargeLog = chargeLog;
                        log(chargeLog);
                    }
                })
                .catch(() => {})
                .then(() => {
                    powerBusy = false;
                });
        }
        await ensureScrcpyRunning(readyDevice.serial, log);
        const targets = targetsFromConfig().filter((item) => item.source === 'fortitoken');
        const accounts = targets.map((item) => [item.account].concat(item.aliases || []));
        const left = totpRemainingSeconds();
        const retryThisWindow = pendingRetry && left >= MIN_SECONDS_TO_SEND;
        pendingRetry = false;
        if (retryThisWindow) {
            log('Retrying this window: ' + left + 's left. Reading and posting now.');
        } else if (pendingReveal || left < MIN_SECONDS_TO_SEND) {
            pendingReveal = false;
            if (left >= 16) {
                log('Keeping codes visible before the next read (' + left + 's left).');
                try {
                    await keepCodesVisible({ accounts, log });
                } catch (err) {
                    log('Keep-visible failed: ' + String((err && err.message) || err || 'unknown'));
                }
            } else {
                log(
                    'Time remaining ' +
                        left +
                        's. Waiting for the new codes instead of a late reveal.',
                );
            }
            await waitForFreshWindow(PREFERRED_LEFT_TO_READ);
            log('Fresh window: ' + totpRemainingSeconds() + 's left. Reading and posting now.');
        } else {
            log('Fresh window: ' + left + 's left. Reading and posting now.');
        }
        const codesThisCycle = new Map();
        const postedTitles = new Set();
        let staleCount = 0;
        await collectFortiTokenCodes({
            accounts,
            log,
            onCaptured: async (sms) => {
                const target = targets.find((item) => matchTarget(sms, item));
                if (!target) {
                    return;
                }
                if (!sms.code) {
                    const wait = totpRemainingSeconds();
                    log(
                        'FortiToken ' +
                            target.title +
                            ': could not read digits. ' +
                            waitMessage(wait),
                    );
                    return;
                }
                const owner = codesThisCycle.get(sms.code);
                if (owner && owner !== target.title) {
                    log(
                        'Skip "' +
                            target.title +
                            '": that code was already read for "' +
                            owner +
                            '".',
                    );
                    return;
                }
                const posted = await pushNewCode(sms, state, log, target);
                if (posted === 'posted' || posted === 'done') {
                    postedTitles.add(target.title);
                    codesThisCycle.set(sms.code, target.title);
                } else if (posted === 'stale') {
                    staleCount += 1;
                    if (!codesThisCycle.has(sms.code)) {
                        codesThisCycle.set(sms.code, target.title);
                    }
                } else if (!codesThisCycle.has(sms.code)) {
                    codesThisCycle.set(sms.code, target.title);
                }
            },
        });
        const remaining = totpRemainingSeconds();
        const needed = targets.length;
        if (staleCount >= needed && postedTitles.size === 0) {
            if (remaining >= 18) {
                return { posted: 0, needed, retrySoon: true };
            }
            return {
                posted: 0,
                needed,
                retrySoon: false,
                waitForNext: true,
            };
        }
        const retrySoon = postedTitles.size < needed && remaining >= MIN_SECONDS_TO_SEND;
        return { posted: postedTitles.size, needed, retrySoon };
    }

    async function run() {
        if (stopped) {
            return;
        }
        let outcome = { posted: 0, needed: 0, retrySoon: true };
        try {
            outcome = await tick();
        } catch (err) {
            log(err.message || String(err));
        }
        if (stopped) {
            return;
        }
        const remaining = totpRemainingSeconds();
        let delayMs;
        if (outcome.waitMs) {
            delayMs = outcome.waitMs;
        } else if (outcome.waitForNext) {
            pendingRetry = false;
            pendingReveal = false;
            delayMs = Math.max(400, totpRemainingSeconds() * 1000 + 1500);
            log(
                'Old digits still on screen. Posting as soon as the next 30s window starts (' +
                    remaining +
                    's).',
            );
        } else if (outcome.retrySoon) {
            pendingRetry = true;
            pendingReveal = false;
            delayMs = 600;
            if (outcome.needed) {
                log(
                    'Retry in 0.6s (' +
                        outcome.posted +
                        '/' +
                        outcome.needed +
                        ' posted, ' +
                        remaining +
                        's left).',
                );
            }
        } else {
            const leftNow = totpRemainingSeconds();
            if (leftNow > 18) {
                pendingReveal = true;
                pendingRetry = false;
                delayMs = Math.max(400, (leftNow - 18) * 1000);
                log('Keeping codes visible 18s before the next window (' + leftNow + 's).');
            } else {
                delayMs = msUntilNextWindow();
                log('Next read at the start of the next 30s window (' + leftNow + 's).');
            }
        }
        timer = setTimeout(run, Math.max(400, delayMs));
    }

    log('Posting to ' + getConfig().url);
    log('Config ' + configPath());
    log('Policy: Wi-Fi debugging first, USB debugging fallback.');
    log('Policy: USB cable stays connected for charging so the phone does not turn off or shut down.');
    log('Policy: keep FortiToken in front with codes visible; post CC/CM/CIS at the start of each 30s window.');
    run();
    return () => {
        stopped = true;
        if (timer) {
            clearTimeout(timer);
        }
    };
}

if (require.main === module) {
    startWatch();
}

module.exports = { startWatch };
