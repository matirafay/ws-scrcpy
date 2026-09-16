const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { run } = require('../lib/adb');
const { scriptFile } = require('../lib/paths');

const CANDIDATES = [
    process.env.SCRCPY,
    'C:\\2C-Health\\scrcpy-win64-v4.1\\scrcpy.exe',
    path.join(process.env.LOCALAPPDATA || '', 'scrcpy', 'scrcpy.exe'),
    path.join(process.env.USERPROFILE || '', 'scrcpy', 'scrcpy.exe'),
    'C:\\scrcpy\\scrcpy.exe',
    'C:\\Program Files\\scrcpy\\scrcpy.exe',
    'C:\\Program Files (x86)\\scrcpy\\scrcpy.exe',
].filter(Boolean);

async function findScrcpy() {
    for (const candidate of CANDIDATES) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }
    try {
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        const { stdout } = await run(cmd, ['scrcpy']);
        const found = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
        if (found) {
            return found;
        }
    } catch (_err) {
        // not on PATH
    }
    return null;
}

function isScrcpyRunning() {
    try {
        const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq scrcpy.exe', '/NH'], {
            windowsHide: true,
            encoding: 'utf8',
        });
        return /scrcpy\.exe/i.test(out);
    } catch (_err) {
        return false;
    }
}

function lockScrcpyWindow() {
    const script = scriptFile('lock-scrcpy-window.ps1');
    if (!fs.existsSync(script)) {
        return '';
    }
    try {
        return String(
            execFileSync(
                'powershell.exe',
                ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
                { windowsHide: true, encoding: 'utf8', timeout: 8000 },
            ),
        ).trim();
    } catch (_err) {
        return '';
    }
}

async function startScrcpy(serial) {
    const bin = await findScrcpy();
    if (!bin) {
        return {
            ok: false,
            message:
                'scrcpy.exe was not found. Keep using your existing scrcpy command window; SMS reading uses ADB and works while scrcpy is already mirroring.',
        };
    }
    const args = [];
    if (serial) {
        args.push('-s', serial);
    }
    args.push('--stay-awake', '--always-on-top');
    spawn(bin, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: path.dirname(bin),
    }).unref();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const locked = lockScrcpyWindow();
    return {
        ok: true,
        binary: bin,
        message: 'Started phone mirror (no console; Close button disabled). ' + locked,
    };
}

async function ensureScrcpyRunning(serial, logFn) {
    const log = typeof logFn === 'function' ? logFn : () => {};
    if (isScrcpyRunning()) {
        lockScrcpyWindow();
        return true;
    }
    log('Phone mirror is not running. Starting it again.');
    const result = await startScrcpy(serial);
    if (!result.ok) {
        log(result.message);
        return false;
    }
    log(result.message);
    return true;
}

module.exports = { findScrcpy, startScrcpy, ensureScrcpyRunning, lockScrcpyWindow };
