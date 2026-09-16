const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { vendorAdb } = require('./paths');

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
    adbPath,
    dumpUi,
    listDevices,
    parseNodes,
    run,
    screencapPng,
    shell,
    withSerial,
};
