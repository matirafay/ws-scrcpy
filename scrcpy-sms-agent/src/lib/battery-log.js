const fs = require('fs');
const path = require('path');
const { shell } = require('./adb');
const { configPath } = require('./config');

const MAX_LOG_BYTES = 5 * 1024 * 1024;
// The watch loop samples about every 45s; write each of those samples.
const SAMPLE_EVERY_MS = 40000;
const STUCK_BELOW_LEVEL = 95;

// Charger driver nodes. Names differ between vendors (OPPO/realme, MediaTek
// clones, Qualcomm); missing ones are simply left out of the log line.
const BATTERY_NODES = [
    'status',
    'capacity',
    'current_now',
    'voltage_now',
    'temp',
    'health',
    'charge_type',
    'charge_timeout',
    'notify_code',
    'mmi_charging_enable',
    'stop_charging_enable',
    'charging_enabled',
    'battery_charging_enabled',
    'input_suspend',
    'input_current_settled',
    'charge_term_current',
];
const SUPPLY_NODES = ['usb/online', 'usb/current_max', 'usb/type', 'ac/online', 'ac/current_max', 'charger/online'];

const STATUS_NAMES = { 1: 'unknown', 2: 'charging', 3: 'discharging', 4: 'not charging', 5: 'full' };

function batteryLogPath() {
    return path.join(path.dirname(configPath()), 'sms-agent-battery.log');
}

function snapshotCommand() {
    const battery = BATTERY_NODES.map((name) => 'battery/' + name);
    return (
        'dumpsys battery; for f in ' +
        battery.concat(SUPPLY_NODES).join(' ') +
        '; do v=$(cat /sys/class/power_supply/$f 2>/dev/null); [ -n "$v" ] && echo "sysfs:$f=$v"; done'
    );
}

function parseSnapshot(text) {
    const src = String(text || '');
    const flag = (name) => new RegExp('^\\s*' + name + '\\s*:\\s*(true|1)\\s*$', 'im').test(src);
    const num = (name) => {
        const match = src.match(new RegExp('^\\s*' + name + '\\s*:\\s*(-?\\d+)\\s*$', 'im'));
        return match ? Number(match[1]) : null;
    };
    const sysfs = {};
    src.split(/\r?\n/).forEach((line) => {
        const match = line.trim().match(/^sysfs:([a-z_]+\/[a-z_]+)=(.*)$/i);
        if (match) {
            sysfs[match[1].replace(/^battery\//, '')] = match[2].trim();
        }
    });
    const status = num('status');
    const snapshot = {
        level: num('level'),
        status,
        statusName: STATUS_NAMES[status] || (sysfs.status ? sysfs.status.toLowerCase() : 'unknown'),
        usb: flag('USB powered'),
        ac: flag('AC powered'),
        wireless: flag('Wireless powered'),
        health: num('health'),
        temperature: num('temperature'),
        voltage: num('voltage'),
        maxChargingCurrent: num('Max charging current'),
        // Vendor extras printed by some battery services (OPPO/realme).
        chargerVoltage: num('Charger voltage'),
        batteryCurrent: num('Battery current'),
        sysfs,
    };
    snapshot.plugged = snapshot.usb || snapshot.ac || snapshot.wireless;
    // Some clones never fill in dumpsys status; fall back to the driver's word.
    snapshot.charging = status === 2 || (status == null && /^charging/i.test(sysfs.status || ''));
    snapshot.full = status === 5 || (status == null && /^full/i.test(sysfs.status || ''));
    return snapshot;
}

async function readBatterySnapshot(serial) {
    return parseSnapshot(await shell(serial, snapshotCommand()));
}

function appendBatteryLog(entry) {
    const file = batteryLogPath();
    try {
        if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
            // Keep the ".log" ending so the rotated file stays git-ignored.
            fs.renameSync(file, file.replace(/\.log$/, '.old.log'));
        }
    } catch (_err) {
        // Rotation is best-effort; keep appending to the current file.
    }
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

function describe(snapshot) {
    const parts = [
        (snapshot.level != null ? snapshot.level + '%' : 'level unknown') + ' ' + snapshot.statusName,
        snapshot.plugged ? 'plugged via ' + (snapshot.ac ? 'AC' : snapshot.usb ? 'USB' : 'wireless') : 'unplugged',
    ];
    if (snapshot.temperature != null) {
        parts.push((snapshot.temperature / 10).toFixed(1) + 'C');
    }
    ['charge_timeout', 'notify_code', 'mmi_charging_enable', 'input_suspend', 'charging_enabled'].forEach((name) => {
        if (snapshot.sysfs[name] !== undefined) {
            parts.push(name + '=' + snapshot.sysfs[name]);
        }
    });
    return parts.join(', ');
}

// Records the phone's charging state over time so a stall can be explained
// afterwards: one JSON line per minute and one on every state change, plus a
// plain message in the agent log when charging stops, resumes or stays off
// after the battery was full.
function createBatteryLogger(options = {}) {
    const log = typeof options.log === 'function' ? options.log : () => {};
    const read = options.read || readBatterySnapshot;
    const write = options.write || appendBatteryLog;
    const clock = options.now || Date.now;
    const everyMs = options.everyMs || SAMPLE_EVERY_MS;

    let lastKey = '';
    let lastWriteAt = 0;
    let fullAt = 0;
    let warnedAtLevel = null;
    let deviceGone = false;

    function stamp(at) {
        return new Date(at).toISOString();
    }

    async function sample(serial, transport) {
        const snapshot = await read(serial);
        const at = clock();
        const key = [snapshot.statusName, snapshot.plugged, snapshot.level].join('|');
        const stateKey = [snapshot.statusName, snapshot.plugged].join('|');
        const changed = stateKey !== lastKey.split('|').slice(0, 2).join('|');
        const events = [];

        if (deviceGone) {
            deviceGone = false;
            events.push('device-back');
        }
        if (changed && lastKey) {
            events.push('state-change');
            log('Battery: ' + describe(snapshot) + '.');
        }
        if ((snapshot.full || snapshot.level === 100) && !fullAt) {
            fullAt = at;
            warnedAtLevel = null;
            events.push('reached-full');
            log('Battery: reached full (' + describe(snapshot) + ').');
        }
        if (fullAt && snapshot.charging && snapshot.level != null && snapshot.level < 100) {
            const minutes = Math.round((at - fullAt) / 60000);
            events.push('recharge-started');
            log('Battery: charging resumed at ' + snapshot.level + '%, ' + minutes + ' min after it was full.');
            fullAt = 0;
            warnedAtLevel = null;
        }
        const stuck =
            fullAt &&
            snapshot.plugged &&
            !snapshot.charging &&
            snapshot.level != null &&
            snapshot.level <= STUCK_BELOW_LEVEL;
        if (stuck && (warnedAtLevel == null || snapshot.level <= warnedAtLevel - 5)) {
            warnedAtLevel = snapshot.level;
            const minutes = Math.round((at - fullAt) / 60000);
            events.push('not-recharging');
            log(
                'Battery: NOT recharging. It reached full ' +
                    minutes +
                    ' min ago and is still plugged in, now ' +
                    describe(snapshot) +
                    '. Details are in ' +
                    batteryLogPath(),
            );
        }
        if (!snapshot.plugged && fullAt) {
            // Unplugging resets most charger latches, so start the watch again.
            fullAt = 0;
            warnedAtLevel = null;
        }

        if (events.length || key !== lastKey || at - lastWriteAt >= everyMs) {
            lastWriteAt = at;
            write(
                Object.assign(
                    { time: stamp(at), serial: serial || '', transport: transport || '' },
                    events.length ? { events } : {},
                    snapshot,
                ),
            );
        }
        lastKey = key;
        return snapshot;
    }

    // The phone dropping off ADB is part of the timeline too (cable, port, USB mode).
    function noDevice(reason) {
        if (deviceGone) {
            return;
        }
        deviceGone = true;
        try {
            write({ time: stamp(clock()), events: ['no-device'], reason: String(reason || '') });
        } catch (_err) {
            // Logging must never stop the watch loop.
        }
    }

    return { sample, noDevice };
}

module.exports = {
    appendBatteryLog,
    batteryLogPath,
    createBatteryLogger,
    parseSnapshot,
    readBatterySnapshot,
};
