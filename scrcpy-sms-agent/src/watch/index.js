const { listDevices } = require('../services/sms');
const { collectFortiTokenCodes, waitForFreshWindow, totpRemainingSeconds, PREFERRED_LEFT_TO_READ, MIN_LEFT_TO_POST } = require('../services/fortitoken');
const { pushSms } = require('../lib/push');
const { getConfig, configPath } = require('../lib/config');
const { DEFAULT_TARGETS } = require('../lib/defaults');
const { ensureScrcpyRunning } = require('../services/scrcpy');
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
        return { lastSentCode: '', lastSent: {} };
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
    const key = target.automationShortCode + ':' + target.title;
    const left = totpRemainingSeconds();
    const enough = left >= MIN_SECONDS_TO_SEND;
    log(
        '"' +
            target.title +
            '": time remaining ' +
            left +
            's. ' +
            (enough ? 'Enough to send to the endpoint.' : 'Not enough to send. ' + waitMessage(left)),
    );
    if (state.lastSent[key] === sms.code) {
        log('Code not updated for "' + target.title + '". ' + waitMessage(left));
        return false;
    }
    if (!enough) {
        return false;
    }
    const result = await pushSms(sms, {
        title: target.title,
        automationShortCode: target.automationShortCode,
    });
    state.lastSent[key] = sms.code;
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
    return true;
}

function startWatch(options = {}) {
    const log = options.log || ((message) => console.log(message));
    const state = loadState();
    let timer = null;
    let stopped = false;

    function msUntilNextWindow() {
        return totpRemainingSeconds() * 1000 + 450;
    }

    async function tick() {
        const devices = await listDevices();
        const ready = devices.filter((device) => device.state === 'device');
        if (!ready.length) {
            log('Waiting for an authorized USB phone.');
            return { posted: 0, needed: 0, retrySoon: true };
        }
        await ensureScrcpyRunning(ready[0].serial, log);
        const left = totpRemainingSeconds();
        if (left < PREFERRED_LEFT_TO_READ) {
            log(
                'Time remaining ' +
                    left +
                    's. Waiting for the next 30s window so codes can be posted with more time left.',
            );
        } else {
            log('Fresh window: ' + left + 's left. Reading and posting now.');
        }
        await waitForFreshWindow(PREFERRED_LEFT_TO_READ);
        const afterWait = totpRemainingSeconds();
        if (afterWait !== left && afterWait >= PREFERRED_LEFT_TO_READ) {
            log('Fresh window: ' + afterWait + 's left. Reading and posting now.');
        }
        const targets = targetsFromConfig().filter((item) => item.source === 'fortitoken');
        const codesThisCycle = new Map();
        const postedTitles = new Set();
        await collectFortiTokenCodes({
            accounts: targets.map((item) => [item.account].concat(item.aliases || [])),
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
                const key = target.automationShortCode + ':' + target.title;
                const posted = await pushNewCode(sms, state, log, target);
                if (posted || (state.lastSent && state.lastSent[key] === sms.code)) {
                    postedTitles.add(target.title);
                    codesThisCycle.set(sms.code, target.title);
                } else if (!codesThisCycle.has(sms.code)) {
                    codesThisCycle.set(sms.code, target.title);
                }
            },
        });
        const remaining = totpRemainingSeconds();
        const needed = targets.length;
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
        if (outcome.retrySoon) {
            delayMs = 1000;
            if (outcome.needed) {
                log(
                    'Retry in 1s (' +
                        outcome.posted +
                        '/' +
                        outcome.needed +
                        ' posted, ' +
                        remaining +
                        's left).',
                );
            }
        } else {
            delayMs = msUntilNextWindow();
            log('Next read at the start of the next 30s window (' + remaining + 's).');
        }
        timer = setTimeout(run, Math.max(400, delayMs));
    }

    log('Posting to ' + getConfig().url);
    log('Config ' + configPath());
    log('FortiToken: OCR visible codes first; tap eye only for dashed/hidden rows, once per window.');
    log('Post at the start of each 30s window (target ' + PREFERRED_LEFT_TO_READ + 's+ remaining).');
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
