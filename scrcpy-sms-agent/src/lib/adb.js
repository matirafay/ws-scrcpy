const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { vendorAdb, scriptFile } = require('./paths');

const DEFAULT_ADB = path.join(
    process.env.LOCALAPPDATA || '',
    'Android',
    'Sdk',
    'platform-tools',
    'adb.exe',
);

function bundledAdb() {
    const healthAdb = 'C:\\2C-Health\\scrcpy-win64-v4.1\\adb.exe';
    const names = process.platform === 'win32' ? 'adb.exe' : 'adb';
    return [
        healthAdb,
        process.env.ADB,
        process.resourcesPath ? path.join(process.resourcesPath, 'platform-tools', names) : '',
        vendorAdb(names),
        DEFAULT_ADB,
    ].filter(Boolean);
}

function adbPath() {
    for (const candidate of bundledAdb()) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return process.platform === 'win32' ? 'adb.exe' : 'adb';
}

function run(bin, args, options = {}) {
    const timeoutMs = options.timeoutMs || 25000;
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`Timed out: ${bin} ${args.join(' ')}`));
        }, timeoutMs);
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error((stderr || stdout || `exit ${code}`).trim()));
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

function adb(args, options) {
    const attempts = 3;
    return (async () => {
        let lastErr;
        for (let i = 0; i < attempts; i++) {
            try {
                return await run(adbPath(), args, options);
            } catch (err) {
                lastErr = err;
                const transient = /exit 137|Timed out/i.test(String(err && err.message));
                if (!transient || i === attempts - 1) {
                    throw err;
                }
                await new Promise((resolve) => setTimeout(resolve, 800));
            }
        }
        throw lastErr;
    })();
}

async function listDevices() {
    const { stdout } = await adb(['devices', '-l']);
    return stdout
        .split(/\r?\n/)
        .slice(1)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const parts = line.split(/\s+/);
            const serial = parts[0];
            const state = parts[1];
            const model = (line.match(/model:(\S+)/) || [])[1] || '';
            return { serial, state, model, raw: line };
        })
        .filter((d) => d.serial && d.serial !== 'List');
}

function isWirelessSerial(serial) {
    return /:\d+$/.test(String(serial || ''));
}

function pickReadyDevice(devices) {
    const ready = (devices || []).filter((device) => device.state === 'device');
    if (!ready.length) {
        return null;
    }
    const wifi = ready.find((device) => isWirelessSerial(device.serial));
    const usb = ready.find((device) => !isWirelessSerial(device.serial));
    return wifi || usb || ready[0];
}

function parseWifiIp(text) {
    const inet = String(text || '').match(/\binet\s+(\d+\.\d+\.\d+\.\d+)/);
    if (inet && !String(inet[1]).startsWith('127.')) {
        return inet[1];
    }
    const lan = String(text || '').match(
        /\b(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)\b/,
    );
    return lan ? lan[1] : '';
}

async function phoneWifiIp(serial) {
    try {
        const ip = parseWifiIp(await shell(serial, 'ip -f inet addr show wlan0'));
        if (ip) {
            return ip;
        }
    } catch (_err) {
        // fall through
    }
    try {
        const raw = String(await shell(serial, 'getprop dhcp.wlan0.ipaddress')).trim();
        if (/^\d+\.\d+\.\d+\.\d+$/.test(raw)) {
            return raw;
        }
    } catch (_err) {
        // fall through
    }
    return '';
}

function rememberWirelessHost(host) {
    try {
        const { getConfig, saveConfig } = require('./config');
        const cfg = getConfig();
        if (cfg.wirelessAdb !== host) {
            saveConfig(Object.assign({}, cfg, { wirelessAdb: host }));
        }
    } catch (_err) {
        // Keep running even if the config file cannot be updated.
    }
}

async function connectWireless(host) {
    const { stdout, stderr } = await run(adbPath(), ['connect', host], { timeoutMs: 12000 });
    const text = String(stdout || '') + String(stderr || '');
    if (!/connected to|already connected/i.test(text)) {
        throw new Error(text.trim() || 'adb connect failed');
    }
    return true;
}

let tcpipEnabledThisSession = false;
let lastWirelessStatus = '';

function logWireless(log, message) {
    if (!message || message === lastWirelessStatus) {
        return;
    }
    lastWirelessStatus = message;
    log(message);
}

async function ensureWirelessAdb(logFn) {
    const log = typeof logFn === 'function' ? logFn : () => {};
    const { getConfig } = require('./config');
    const cfg = getConfig();
    let devices = await listDevices();
    let ready = pickReadyDevice(devices);
    if (ready && isWirelessSerial(ready.serial)) {
        rememberWirelessHost(ready.serial);
        await releaseUsbDataForCharging(log);
        return ready;
    }
    const usb = (devices || []).find((device) => device.state === 'device' && !isWirelessSerial(device.serial));
    let host = String(cfg.wirelessAdb || '').trim();
    if (usb && !tcpipEnabledThisSession) {
        const ip = await phoneWifiIp(usb.serial);
        if (ip) {
            host = ip + ':5555';
            try {
                await adb(withSerial(['tcpip', '5555'], usb.serial), { timeoutMs: 10000 });
                tcpipEnabledThisSession = true;
                logWireless(
                    log,
                    'Enabled Wi-Fi debugging (' +
                        host +
                        '). USB cable stays connected so the phone keeps charging.',
                );
                await new Promise((resolve) => setTimeout(resolve, 1400));
            } catch (err) {
                logWireless(
                    log,
                    'Could not enable Wi-Fi debugging: ' +
                        String((err && err.message) || err || 'unknown') +
                        '. Using USB debugging as fallback.',
                );
            }
        }
    }
    if (host) {
        try {
            await connectWireless(host);
            rememberWirelessHost(host);
            logWireless(log, 'Connected over Wi-Fi debugging: ' + host);
        } catch (err) {
            logWireless(
                log,
                'Wi-Fi debugging not ready at ' +
                    host +
                    '. Using USB debugging as fallback. Keep the cable plugged so the phone does not shut down.',
            );
        }
    }
    devices = await listDevices();
    const picked = pickReadyDevice(devices);
    if (picked && isWirelessSerial(picked.serial)) {
        await releaseUsbDataForCharging(log);
    }
    return picked;
}

let lastUsbReleaseAt = 0;

async function releaseUsbDataForCharging(logFn) {
    const log = typeof logFn === 'function' ? logFn : () => {};
    const now = Date.now();
    if (now - lastUsbReleaseAt < 60000) {
        return false;
    }
    const devices = await listDevices();
    const wifi = (devices || []).find((device) => device.state === 'device' && isWirelessSerial(device.serial));
    if (!wifi) {
        return false;
    }
    lastUsbReleaseAt = now;
    try {
        // Drop the USB gadget to charge-only. Wi-Fi debugging stays up.
        await adb(withSerial(['shell', 'svc usb setFunctions'], wifi.serial), { timeoutMs: 8000 });
    } catch (_err) {
        // Some clones ignore an empty function list; Device Manager release still charges.
    }
    const script = scriptFile('enable-phone-charging.ps1');
    if (!fs.existsSync(script)) {
        return false;
    }
    try {
        const { stdout } = await run(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
            { timeoutMs: 20000 },
        );
        const text = String(stdout || '');
        if (/already gone|Disable-PnpDevice ok/i.test(text)) {
            log(
                'Released the USB data device so the cable can charge. The agent stays on Wi-Fi debugging.',
            );
            return true;
        }
        log(
            'Could not release the USB data device. Remove "I15 Pro Max" from Device Manager so the phone charges. ' +
                text.trim().split(/\r?\n/).slice(-3).join(' '),
        );
    } catch (err) {
        log(
            'Could not release the USB data device: ' +
                String((err && err.message) || err || 'unknown') +
                '. Remove "I15 Pro Max" from Device Manager so the phone charges.',
        );
    }
    return false;
}

async function recoverAdb() {
    try {
        await run(adbPath(), ['kill-server'], { timeoutMs: 8000 });
    } catch (_err) {
        // Server may already be down.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    await run(adbPath(), ['start-server'], { timeoutMs: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 800));
    try {
        const { getConfig } = require('./config');
        const host = String((getConfig().wirelessAdb || '')).trim();
        if (host) {
            await connectWireless(host);
        }
    } catch (_err) {
        // Wireless reconnect is best-effort after an ADB restart.
    }
}

let usbCache = { at: 0, info: null };

function emptyUsbInfo() {
    return { present: false, chargingOnly: false, adbLike: false, raw: [] };
}

async function peekPhoneUsb() {
    const now = Date.now();
    if (usbCache.info && now - usbCache.at < 8000) {
        return usbCache.info;
    }
    const script = scriptFile('peek-phone-usb.ps1');
    if (!fs.existsSync(script)) {
        usbCache = { at: now, info: emptyUsbInfo() };
        return usbCache.info;
    }
    try {
        const { stdout } = await run(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
            { timeoutMs: 12000 },
        );
        const lines = String(stdout || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        const chargingOnly = lines.some(
            (line) => /VID_0E8D&PID_20FF/i.test(line) || /HIDClass.*VID_0E8D/i.test(line),
        );
        const adbLike = lines.some((line) =>
            /ADB|Android Composite|WinUSB|PID_201C|PID_2006|PID_2007/i.test(line),
        );
        usbCache = {
            at: now,
            info: {
                present: lines.length > 0,
                chargingOnly: chargingOnly && !adbLike,
                adbLike,
                raw: lines.slice(0, 8),
            },
        };
        return usbCache.info;
    } catch (_err) {
        usbCache = { at: now, info: emptyUsbInfo() };
        return usbCache.info;
    }
}

async function usbWaitMessage(devices) {
    const list = Array.isArray(devices) ? devices : [];
    if (list.some((device) => device.state === 'unauthorized' || device.state === 'offline')) {
        return 'Phone is connected but debugging is not allowed. Unlock it and tap Allow USB debugging, or reconnect Wi-Fi debugging.';
    }
    let host = '';
    try {
        const { getConfig } = require('./config');
        host = String((getConfig().wirelessAdb || '')).trim();
    } catch (_err) {
        host = '';
    }
    const usb = await peekPhoneUsb();
    if (host) {
        return (
            'No ADB device. Trying Wi-Fi first at ' +
            host +
            ', then USB as fallback. Keep the phone unlocked on the same Wi-Fi. Keep the cable plugged to charge.'
        );
    }
    if (usb.chargingOnly) {
        return 'Phone is charging over USB. Unlock it and allow USB debugging as fallback, or keep Wi-Fi debugging connected.';
    }
    if (usb.present) {
        return 'USB phone is present but ADB is not ready. Unlock it and allow USB debugging as fallback, or reconnect Wi-Fi debugging.';
    }
    return 'No phone over Wi-Fi or USB debugging. Keep the cable plugged to charge. Unlock the phone and allow Wi-Fi or USB debugging.';
}

function parseBatteryDump(text) {
    const src = String(text || '');
    const flag = (name) => new RegExp(name + '\\s*:\\s*(true|1)', 'i').test(src);
    const num = (name) => {
        const match = src.match(new RegExp(name + '\\s*:\\s*(-?\\d+)', 'i'));
        return match ? Number(match[1]) : null;
    };
    const usb = flag('USB powered');
    const ac = flag('AC powered');
    const wireless = flag('Wireless powered');
    const status = num('status');
    const level = num('level');
    const plugged = usb || ac || wireless;
    // 2=charging, 5=full. USB powered alone is not charging (4=not charging).
    const charging = status === 2 || status === 5;
    return { usb, ac, wireless, status, level, plugged, charging, currentNow: null };
}

async function keepPhonePowered(serial) {
    if (!serial) {
        return { charging: false, plugged: false, level: null, usb: false, currentNow: null };
    }
    for (const command of [
        'svc power stayon true',
        'settings put global stay_on_while_plugged_in 7',
        'settings put global wifi_sleep_policy 2',
    ]) {
        try {
            await shell(serial, command);
        } catch (_err) {
            // Clone firmware may reject one of these; the others still help.
        }
    }
    let battery = { charging: false, plugged: false, level: null, usb: false, currentNow: null };
    try {
        battery = parseBatteryDump(await shell(serial, 'dumpsys battery'));
    } catch (_err) {
        // Fall through to current_now.
    }
    try {
        const raw = Number(await shell(serial, 'cat /sys/class/power_supply/battery/current_now'));
        if (!Number.isNaN(raw)) {
            battery.currentNow = raw;
        }
    } catch (_err) {
        // dumpsys status is enough when sysfs is blocked.
    }
    try {
        const sysStatus = String(await shell(serial, 'cat /sys/class/power_supply/battery/status') || '').trim();
        if (/^charg/i.test(sysStatus) || /^full/i.test(sysStatus)) {
            battery.charging = true;
        }
    } catch (_err) {
        // Keep dumpsys charging. MediaTek current_now is negative while charging;
        // never treat that sign as "not charging".
        if (battery.status == null && battery.currentNow != null && battery.currentNow < -50000) {
            battery.charging = true;
        }
    }
    return battery;
}

function withSerial(args, serial) {
    return serial ? ['-s', serial, ...args] : args;
}

async function shell(serial, command) {
    const { stdout } = await adb(withSerial(['shell', command], serial));
    return stdout.trim();
}

async function dumpUi(serial) {
    try {
        const { stdout } = await adb(withSerial(['exec-out', 'uiautomator dump /dev/tty'], serial), {
            timeoutMs: 20000,
        });
        const start = stdout.indexOf('<');
        if (start >= 0) {
            return stdout.slice(start);
        }
    } catch (_err) {
        // Fall back to dump-and-pull on phones that reject /dev/tty.
    }
    const remote = '/sdcard/window_dump.xml';
    const local = path.join(os.tmpdir(), `scrcpy-sms-ui-${process.pid}.xml`);
    await adb(withSerial(['shell', 'uiautomator dump ' + remote], serial), { timeoutMs: 40000 });
    await adb(withSerial(['pull', remote, local], serial));
    return fs.readFileSync(local, 'utf8');
}

async function screencapPng(serial, destPath) {
    const remote = '/sdcard/scrcpy-sms-cap.png';
    await shell(serial, 'screencap -p ' + remote);
    await adb(withSerial(['pull', remote, destPath], serial));
    try {
        await shell(serial, 'rm ' + remote);
    } catch (_err) {
        // Best-effort cleanup.
    }
    // Some clone phones write a 0-byte file and still exit 0.
    let size = 0;
    try {
        size = fs.statSync(destPath).size;
    } catch (_err) {
        size = 0;
    }
    if (size < 1024) {
        try {
            fs.unlinkSync(destPath);
        } catch (_err) {
            // ignore
        }
        throw new Error('screencap produced empty image');
    }
    return destPath;
}

function parseBounds(bounds) {
    const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(bounds || '');
    if (!m) {
        return null;
    }
    const left = Number(m[1]);
    const top = Number(m[2]);
    const right = Number(m[3]);
    const bottom = Number(m[4]);
    return {
        left,
        top,
        right,
        bottom,
        x: Math.round((left + right) / 2),
        y: Math.round((top + bottom) / 2),
    };
}

function parseNodes(xml) {
    const nodes = [];
    xml.replace(/<node\b([^>]*)>/g, (_m, attrs) => {
        const node = {};
        attrs.replace(/([a-zA-Z0-9:_-]+)="([^"]*)"/g, (_, key, value) => {
            node[key] = value
                .replace(/&amp;/g, '&')
                .replace(/&#10;/g, '\n')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>');
        });
        node.boundsBox = parseBounds(node.bounds);
        nodes.push(node);
        return _m;
    });
    return nodes;
}

module.exports = {
    adb,
    dumpUi,
    ensureWirelessAdb,
    isWirelessSerial,
    keepPhonePowered,
    listDevices,
    parseNodes,
    pickReadyDevice,
    recoverAdb,
    releaseUsbDataForCharging,
    run,
    screencapPng,
    shell,
    usbWaitMessage,
    withSerial,
};
