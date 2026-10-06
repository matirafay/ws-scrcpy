const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { adb, dumpUi, keepPhonePowered, listDevices, parseNodes, screencapPng, shell, withSerial } = require('../lib/adb');
const { scriptFile } = require('../lib/paths');

const FTM_PACKAGE = 'com.fortinet.android.ftm';
const TOTP_PERIOD_SEC = 30;
const MIN_LEFT_TO_POST = 8;
const PREFERRED_LEFT_TO_READ = 22;
const LIST_SAFE_TAP = { x: 540, y: 210 };
// Only clamp below a real search field. A hard floor (e.g. 400) misses the
 // first FortiToken rows on shorter phones / action-bar layouts.
let cachedSearch = null;
let cachedSearchBottom = 0;
let cachedActionBarBottom = 0;
let cachedEyesByPrefix = Object.create(null);
const DEFAULT_DASH_BY_PREFIX = {
    cm: { x: 242, y: 399 },
    cis: { x: 242, y: 562 },
    cc: { x: 242, y: 725 },
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function totpRemainingSeconds(period = TOTP_PERIOD_SEC) {
    return period - (Math.floor(Date.now() / 1000) % period);
}

async function waitForFreshWindow(minLeft = PREFERRED_LEFT_TO_READ, period = TOTP_PERIOD_SEC) {
    const left = totpRemainingSeconds(period);
    if (left >= minLeft) {
        return left;
    }
    await sleep(left * 1000 + 400);
    await sleep(300);
    return totpRemainingSeconds(period);
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
    const raw = decode(text);
    const spaced = raw.match(/(?<!\d)(\d{3})\s*(\d{3})(?!\d)/);
    if (spaced) {
        return spaced[1] + spaced[2];
    }
    const digits = raw.replace(/\s+/g, '');
    const six = digits.match(/(\d{6})/);
    return six ? six[1] : null;
}

function rowBand(label) {
    const box = label && label.boundsBox;
    if (!box) {
        return null;
    }
    // Rows are ~200px apart on this phone; a 230px band overlaps the next account.
    return { top: box.top - 8, bottom: box.top + 190 };
}

function onSameRow(label, node) {
    const band = rowBand(label);
    if (!band || !node || !node.boundsBox) {
        return false;
    }
    return node.boundsBox.y >= band.top && node.boundsBox.y <= band.bottom;
}

function nearbyCode(nodes, label) {
    const nearby = nodes.filter((n) => onSameRow(label, n));
    for (const node of nearby) {
        const raw = decode(node.text || node['content-desc'] || '');
        if (/hidden value/i.test(raw)) {
            continue;
        }
        const code = normalizeTotp(raw);
        if (code) {
            return code;
        }
    }
    const joined = nearby
        .map((n) => decode(n.text || ''))
        .join(' ')
        .replace(/[^\d]/g, '');
    const grouped = joined.match(/(\d{6,8})/);
    return grouped ? grouped[1] : null;
}

function dashTapPoint(subtitle, label) {
    const box = (subtitle && subtitle.boundsBox) || null;
    if (box) {
        const width = Math.max(1, box.right - box.left);
        // FortiToken 6.6: dashes sit in detail_row_subtitle. Stay left of the
        // countdown donut (~x 500) and chevron (~x 594).
        return {
            x: Math.min(box.left + Math.round(width * 0.45), 460),
            y: Math.round((box.top + box.bottom) / 2),
        };
    }
    if (label && label.boundsBox) {
        return {
            x: Math.min(label.boundsBox.left + 180, 460),
            y: label.boundsBox.bottom + 48,
        };
    }
    return null;
}

function eyeTapPoint(nodes, label) {
    const nearby = nodes.filter((n) => onSameRow(label, n) && n.boundsBox);
    const labelY = label && label.boundsBox ? label.boundsBox.y : 0;
    const eyeBtns = nearby
        .filter((n) => idOf(n).endsWith('detail_row_hide_button'))
        .sort((a, b) => Math.abs(a.boundsBox.y - labelY) - Math.abs(b.boundsBox.y - labelY));
    const eyeBtn = eyeBtns[0];
    if (eyeBtn && eyeBtn.boundsBox) {
        const box = eyeBtn.boundsBox;
        const width = Math.max(1, box.right - box.left);
        return {
            x: box.left + Math.round(width * 0.5),
            y: Math.round((box.top + box.bottom) / 2),
        };
    }
    // 6.6 dropped hide_button. Reveal by tapping the dash / Hidden-value band.
    const subtitle = nearby.find((n) => idOf(n).endsWith('detail_row_subtitle') && n.boundsBox);
    return dashTapPoint(subtitle, label);
}

function codeTapPoint(nodes, label) {
    // On this FortiToken build, tapping totp_detail_summary / subtitle opens
    // "Edit name" / the next screen. Never use those as tap targets.
    return null;
}

function clampTap(tap, searchBottom, actionBarBottom) {
    if (!tap) {
        return null;
    }
    const floor = Math.max(Number(searchBottom || 0), Number(actionBarBottom || 0));
    const minY = floor > 0 ? floor + 24 : 0;
    return {
        x: tap.x,
        y: Math.max(tap.y, minY),
    };
}

async function dismissSearchIfFocused(serial, nodes) {
    const search = (nodes || []).find((node) => idOf(node).endsWith('search_edit_text') && node.focused === 'true');
    if (!search) {
        return;
    }
    await shell(serial, 'input tap ' + LIST_SAFE_TAP.x + ' ' + LIST_SAFE_TAP.y);
    await sleep(80);
}

function parseAccounts(nodes) {
    const labels = nodes.filter((n) => idOf(n).endsWith('detail_row_label'));
    const accounts = [];
    for (const label of labels) {
        const nearby = nodes.filter((n) => onSameRow(label, n));
        const subtitle = nearby.find((n) => idOf(n).endsWith('detail_row_subtitle'));
        const from = decode(label.text);
        const raw = decode((subtitle && (subtitle.text || subtitle['content-desc'])) || '');
        let code = nearbyCode(nodes, label);
        const hidden = !code && (/hidden value/i.test(raw) || !raw);
        if (!from) {
            continue;
        }
        accounts.push({
            from,
            body: from,
            time: 'now',
            source: 'fortitoken',
            code,
            hidden,
            tap: codeTapPoint(nodes, label),
            eye: eyeTapPoint(nodes, label),
            codeBox: subtitle && subtitle.boundsBox ? { ...subtitle.boundsBox } : null,
            // detail_row_accessory is the chevron â€” tapping it opens the detail
            // screen on this FortiToken build. Never treat it as copy.
            copy: null,
        });
    }
    return accounts;
}

function accountMatches(from, account) {
    const name = String(from || '')
        .trim()
        .toLowerCase();
    const needle = String(account || '')
        .trim()
        .toLowerCase();
    if (!name || !needle) {
        return false;
    }
    if (name.includes(needle) || needle.includes(name)) {
        return true;
    }
    const compactName = name.replace(/[^a-z0-9]/g, '');
    const compactNeedle = needle.replace(/[^a-z0-9]/g, '');
    if (compactName.includes(compactNeedle) || compactNeedle.includes(compactName)) {
        return true;
    }
    if (
        (compactName.includes('mahmood') || compactName.includes('mmehmood')) &&
        (compactNeedle.includes('mahmood') || compactNeedle.includes('mmehmood'))
    ) {
        return true;
    }
    return false;
}

function pickAccount(accounts, account) {
    const needle = String(account || '')
        .trim()
        .toLowerCase();
    if (needle) {
        return accounts.find((item) => accountMatches(item.from, needle)) || null;
    }
    return accounts.find((item) => item.code) || accounts[0] || null;
}

function xmlLooksLikeTokenList(xml) {
    const text = String(xml || '');
    if (/name_edittext|Edit name/i.test(text)) {
        return false;
    }
    return (
        /detail_row_label/.test(text) ||
        /otp_list_layout|totp_detail_row_item|OtpTokenListActivity/.test(text)
    );
}

async function keepScreenAwake(serial) {
    await keepPhonePowered(serial);
}

async function currentFocusLine(serial) {
    try {
        const line = await shell(serial, 'dumpsys window | grep mCurrentFocus');
        if (line) {
            return line;
        }
    } catch (_err) {
        // grep may be missing on some builds.
    }
    try {
        const dump = await shell(serial, 'dumpsys window');
        const match = String(dump || '').match(/mCurrentFocus=([^\r\n]+)/);
        return match ? match[1] : '';
    } catch (_err) {
        return '';
    }
}

async function wakeUnlockPhone(serial) {
    await shellQuiet(serial, 'input keyevent KEYCODE_WAKEUP');
    await sleep(450);
    await shellQuiet(serial, 'input swipe 540 1700 540 600 300');
    await sleep(500);
}

async function launchFortiToken(serial) {
    const device = await pickDevice(serial);
    await wakeUnlockPhone(device.serial);
    try {
        await adb(
            withSerial(
                [
                    'shell',
                    'am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ' +
                        FTM_PACKAGE,
                ],
                device.serial,
            ),
        );
    } catch (_err) {
        await adb(
            withSerial(
                ['shell', 'monkey -p ' + FTM_PACKAGE + ' -c android.intent.category.LAUNCHER 1'],
                device.serial,
            ),
        );
    }
    await sleep(900);
    return { ok: true, package: FTM_PACKAGE, device, restarted: false };
}

async function ensureFortiTokenAlive(serial, logFn) {
    const log = typeof logFn === 'function' ? logFn : () => {};
    await keepScreenAwake(serial);
    await wakeUnlockPhone(serial);
    const focus = await currentFocusLine(serial);
    if (/OtpTokenListActivity/i.test(focus)) {
        return true;
    }
    if (/fortinet\.android\.ftm|fortitoken\./i.test(focus)) {
        log('FortiToken is on a sub-screen -> return to the token list');
        await leaveSettings(serial);
        return true;
    }
    log('FortiToken is not in front -> opening it so revealed codes can stay visible');
    await launchFortiToken(serial);
    const after = await peekFortiToken(serial);
    if (/name_edittext|Edit name/i.test(after.xml || '')) {
        await leaveSettings(serial);
    }
    return true;
}

async function dumpAccounts(serial) {
    const xml = await dumpUi(serial);
    const nodes = parseNodes(xml);
    const search = nodes.find((node) => idOf(node).endsWith('search_edit_text') && node.boundsBox);
    if (search) {
        cachedSearch = search.boundsBox;
        cachedSearchBottom = search.boundsBox.bottom;
    }
    const actionBar = nodes.find((node) => idOf(node).endsWith('action_bar') && node.boundsBox);
    if (actionBar) {
        cachedActionBarBottom = actionBar.boundsBox.bottom;
    }
    const accounts = parseAccounts(nodes).map((item) => ({
        ...item,
        tap: clampTap(item.tap, cachedSearchBottom, cachedActionBarBottom),
        eye: item.eye,
    }));
    rememberEyesFromAccounts(accounts);
    await dismissSearchIfFocused(serial, nodes);
    return accounts;
}

async function peekFortiToken(serial, account) {
    let xml = '';
    try {
        xml = await dumpUi(serial);
    } catch (_err) {
        return { onScreen: false, accounts: [], match: null, xml: '' };
    }
    const accounts = parseAccounts(parseNodes(xml));
    return {
        xml,
        onScreen: accounts.length > 0 || /com\.fortinet\.android\.ftm:id\//.test(xml),
        accounts,
        match: pickAccount(accounts, account),
    };
}

function applyCode(match, code) {
    if (!match || !code) {
        return match;
    }
    match.code = code;
    match.hidden = false;
    return match;
}

async function leaveSettings(serial) {
    for (let i = 0; i < 5; i++) {
        const xml = await dumpUi(serial);
        if (xmlLooksLikeTokenList(xml)) {
            return;
        }
        const onEditDialog = /name_edittext/.test(xml) || /Edit name/i.test(xml);
        if (onEditDialog) {
            const nodes = parseNodes(xml);
            const cancel = nodes.find(
                (n) =>
                    idOf(n) === 'android:id/button2' ||
                    /^cancel$/i.test(decode(n.text)),
            );
            if (cancel && cancel.boundsBox) {
                await shellQuiet(serial, 'input tap ' + cancel.boundsBox.x + ' ' + cancel.boundsBox.y);
            } else {
                await shellQuiet(serial, 'input keyevent KEYCODE_BACK');
            }
        } else {
            // Detail screen, settings, or any non-list FortiToken page.
            await shellQuiet(serial, 'input keyevent KEYCODE_BACK');
        }
        await sleep(700);
    }
}

async function findRowOnList(serial, names) {
    const needles = (Array.isArray(names) ? names : [names]).filter(Boolean);
    for (let pass = 0; pass < 8; pass++) {
        const batch = await dumpAccounts(serial);
        for (const name of needles) {
            const match = pickAccount(batch, name);
            if (match && (match.tap || match.eye || match.code || match.from)) {
                return match;
            }
        }
        await shellQuiet(serial, 'input swipe 540 1700 540 800 280');
        await sleep(300);
    }
    return null;
}

function cropBounds(match) {
    if (match && match.codeBox) {
        const box = match.codeBox;
        return {
            left: Math.max(0, box.left),
            top: Math.max(0, box.top),
            right: box.right,
            bottom: box.bottom,
        };
    }
    if (match && match.tap) {
        return {
            left: Math.max(0, match.tap.x - 140),
            top: Math.max(0, match.tap.y - 40),
            right: match.tap.x + 140,
            bottom: match.tap.y + 50,
        };
    }
    return null;
}

function runOcrScript(imagePath, accountHint, extraArgs) {
    const script = scriptFile('ocr-code.ps1');
    return new Promise((resolve) => {
        const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ImagePath', imagePath];
        if (accountHint) {
            args.push('-AccountHint', String(accountHint));
        }
        if (Array.isArray(extraArgs)) {
            args.push(...extraArgs);
        }
        const child = spawn('powershell.exe', args, { windowsHide: true });
        let stdout = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
        });
        child.on('error', () => resolve(null));
        child.on('close', () => {
            const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '';
            if (extraArgs && extraArgs.includes('-CountTotp')) {
                resolve(Number(line) || 0);
                return;
            }
            if (extraArgs && extraArgs.includes('-DumpLines')) {
                resolve(stdout.trim());
                return;
            }
            if (extraArgs && extraArgs.includes('-ListHidden')) {
                resolve(stdout.trim());
                return;
            }
            if (extraArgs && extraArgs.includes('-Analyze')) {
                resolve(stdout.trim());
                return;
            }
            const code = normalizeTotp(line);
            resolve(code);
        });
    });
}

async function captureScrcpyWindowPng(destPath, extraArgs = []) {
    const script = scriptFile('capture-scrcpy.ps1');
    await new Promise((resolve, reject) => {
        const child = spawn(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-OutPath', destPath].concat(
                extraArgs || [],
            ),
            { windowsHide: true },
        );
        let stderr = '';
        let stdout = '';
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
        });
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
        });
        child.on('error', reject);
        child.on('close', (code) => {
            let size = 0;
            try {
                size = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
            } catch (_err) {
                size = 0;
            }
            if (size >= 8000) {
                resolve(destPath);
                return;
            }
            reject(new Error((stderr || stdout || 'scrcpy capture failed').trim() + ' exit=' + code + ' bytes=' + size));
        });
    });
    return destPath;
}

function bestOcrHint(match, names) {
    const candidates = []
        .concat(match && match.from ? [match.from] : [])
        .concat(Array.isArray(names) ? names : names ? [names] : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean);
    if (!candidates.length) {
        return '';
    }
    // Prefer the longest label ("CM - jjilani") over short account ids ("jjilani").
    candidates.sort((a, b) => b.replace(/[^a-z0-9]/gi, '').length - a.replace(/[^a-z0-9]/gi, '').length);
    return candidates[0];
}

function hintPrefix(hint) {
    const compact = String(hint || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
    if (compact.startsWith('cis')) {
        return 'cis';
    }
    if (compact.startsWith('cc')) {
        return 'cc';
    }
    if (compact.startsWith('cm')) {
        return 'cm';
    }
    return '';
}

function rememberEyesFromAccounts(accounts) {
    (accounts || []).forEach((item) => {
        const prefix = hintPrefix(item && item.from);
        if (prefix && item.eye) {
            cachedEyesByPrefix[prefix] = item.eye;
        }
    });
}

function cachedEyeFor(hint, from) {
    const prefix = hintPrefix(hint) || hintPrefix(from);
    if (!prefix) {
        return null;
    }
    return cachedEyesByPrefix[prefix] || DEFAULT_DASH_BY_PREFIX[prefix] || null;
}

function syntheticAccountMatch(names) {
    const list = Array.isArray(names) ? names : names ? [names] : [];
    const from =
        list.find((n) => /^(cc|cm|cis)\b/i.test(String(n).trim())) ||
        list.find((n) => /[\s-]/.test(String(n))) ||
        list[0] ||
        '';
    const hint = bestOcrHint({ from }, list);
    return {
        from,
        body: from,
        time: 'now',
        source: 'fortitoken',
        code: null,
        hidden: null,
        tap: null,
        eye: cachedEyeFor(hint, from),
    };
}

function attachDumpToPending(pending, visible) {
    rememberEyesFromAccounts(visible);
    (pending || []).forEach((item) => {
        const found =
            pickAccount(visible, item.match && item.match.from) || pickAccount(visible, item.names[0]);
        if (!found) {
            if (!item.match.eye) {
                item.match.eye = cachedEyeFor(item.hint, item.match.from);
            }
            return;
        }
        item.match.from = found.from || item.match.from;
        item.match.tap = found.tap || item.match.tap;
        item.match.eye = found.eye || item.match.eye || cachedEyeFor(item.hint, found.from);
        item.match.hidden = Boolean(found.hidden);
        if (found.code && !item.match.code) {
            applyCode(item.match, found.code);
        }
        item.hint = bestOcrHint(item.match, item.names);
    });
}

function ocrDumpLooksLikeTokenList(analysis) {
    const dump = String((analysis && analysis.dump) || '').toLowerCase();
    if (!dump || dump === 'empty_ocr' || dump.startsWith('parse_fail') || dump.startsWith('non_json')) {
        return false;
    }
    if (/cursortab|cursor tab/.test(dump.replace(/\s/g, ''))) {
        return false;
    }
    return /fortitoken|jjilani|mmehmood|tmalik|\bcm\b|\bcis\b|\bcc\b/.test(dump);
}

function ocrLooksLikeFortiToken(analysis) {
    if (!analysis) {
        return false;
    }
    if (analysis.totp > 0) {
        return true;
    }
    if (analysis.hidden && analysis.hidden.length) {
        return true;
    }
    const codes = analysis.codes || {};
    if (codes.cm || codes.cis || codes.cc) {
        return true;
    }
    return ocrDumpLooksLikeTokenList(analysis);
}

function dropDuplicateOcrCodes(pending, logFn) {
    const log = typeof logFn === 'function' ? logFn : () => {};
    const ownedCodes = new Map();
    (pending || []).forEach((item) => {
        const code = item.match && item.match.code ? String(item.match.code) : '';
        if (!code) {
            return;
        }
        if (ownedCodes.has(code)) {
            log(
                'FortiToken debug: drop duplicate OCR code on "' +
                    item.match.from +
                    '" (already assigned to "' +
                    ownedCodes.get(code) +
                    '")',
            );
            item.match.code = null;
        } else {
            ownedCodes.set(code, item.match.from || item.hint);
        }
    });
}

function rowNeedsEye(item, totpOnScreen, hiddenPrefixes, analysis) {
    if (!item || item.match.code) {
        return false;
    }
    const prefix = hintPrefix(item.hint) || hintPrefix(item.match && item.match.from);
    if (!prefix) {
        return false;
    }
    if (hiddenPrefixes && hiddenPrefixes.includes(prefix)) {
        return true;
    }
    // Token list is on screen but this row has no digits — tap its dash band.
    return ocrDumpLooksLikeTokenList(analysis);
}

function emptyOcrAnalysis() {
    return { totp: 0, codes: { cm: null, cis: null, cc: null }, hidden: [], dump: '' };
}

function parseOcrAnalysis(raw) {
    const text = String(raw || '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
        .trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    const json = start >= 0 && end > start ? text.slice(start, end + 1) : text;
    try {
        const parsed = JSON.parse(json || '{}');
        const codes = parsed.codes || {};
        const hidden = Array.isArray(parsed.hidden)
            ? parsed.hidden.map((item) => String(item || '').toLowerCase().trim()).filter(Boolean)
            : String(parsed.hidden || '')
                  .toLowerCase()
                  .split(',')
                  .map((item) => item.trim())
                  .filter(Boolean);
        return {
            totp: Number(parsed.totp) || 0,
            codes: {
                cm: normalizeTotp(codes.cm) || null,
                cis: normalizeTotp(codes.cis) || null,
                cc: normalizeTotp(codes.cc) || null,
            },
            hidden,
            dump: String(parsed.dump || '') || (text && start < 0 ? 'NON_JSON ' + text.slice(0, 120) : ''),
        };
    } catch (_err) {
        const fallback = emptyOcrAnalysis();
        fallback.dump = 'PARSE_FAIL ' + text.slice(0, 160);
        const loose = text.match(/"codes"\s*:\s*\{[^}]*\}/);
        if (loose) {
            try {
                const codes = JSON.parse('{' + loose[0] + '}').codes || {};
                fallback.codes = {
                    cm: normalizeTotp(codes.cm) || null,
                    cis: normalizeTotp(codes.cis) || null,
                    cc: normalizeTotp(codes.cc) || null,
                };
                fallback.totp = [fallback.codes.cm, fallback.codes.cis, fallback.codes.cc].filter(Boolean).length;
            } catch (_inner) {
                // keep empty codes
            }
        }
        return fallback;
    }
}

async function analyzeOcr(imagePath) {
    const raw = await runOcrScript(imagePath, '', ['-Analyze']);
    return parseOcrAnalysis(raw);
}

function applyOcrAnalysis(pending, analysis, logFn, passName) {
    const log = typeof logFn === 'function' ? logFn : () => {};
    if (!analysis) {
        return;
    }
    for (const item of pending) {
        if (item.match.code) {
            continue;
        }
        const prefix = hintPrefix(item.hint) || hintPrefix(item.match.from);
        const ocrCode = prefix ? analysis.codes[prefix] : null;
        log(
            'FortiToken debug: ' +
                passName +
                ' OCR hint="' +
                item.hint +
                '" hit=' +
                Boolean(ocrCode) +
                ' len=' +
                (ocrCode ? String(ocrCode).length : 0),
        );
        if (ocrCode) {
            applyCode(item.match, ocrCode);
        }
    }
}

async function captureScreenPng(serial, destPath) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            try {
                await captureScrcpyWindowPng(destPath);
            } catch (err) {
                lastErr = err;
                await screencapPng(serial, destPath);
            }
            let size = 0;
            try {
                size = fs.statSync(destPath).size;
            } catch (_err) {
                size = 0;
            }
            if (size >= 8000) {
                return destPath;
            }
            lastErr = new Error('capture too small bytes=' + size);
            try {
                fs.unlinkSync(destPath);
            } catch (_err) {
                // ignore
            }
            await sleep(200);
        } catch (err) {
            lastErr = err;
            await sleep(200);
        }
    }
    throw lastErr || new Error('screen capture failed');
}

async function readCodeFromScreenshot(serial, match, names) {
    if (!match || (!match.from && !(names && names.length))) {
        return null;
    }
    const hint = bestOcrHint(match, names);
    const prefix = hintPrefix(hint) || hintPrefix(match.from);
    const full = path.join(os.tmpdir(), `scrcpy-sms-full-${process.pid}-${Date.now()}.png`);
    try {
        try {
            await captureScreenPng(serial, full);
            const analysis = await analyzeOcr(full);
            return prefix ? analysis.codes[prefix] : null;
        } catch (_err) {
            return null;
        }
    } finally {
        try {
            fs.unlinkSync(full);
        } catch (_err) {
            // ignore
        }
    }
}

async function tapAndCapture(serial, account, logFn, opts = {}) {
    const log = typeof logFn === 'function' ? logFn : () => {};
    const allowEye = opts.allowEye !== false;
    const reused = typeof account === 'object' && account && (account.tap || account.eye || account.code);
    const names = reused
        ? [account.from].concat(Array.isArray(opts.aliases) ? opts.aliases : []).filter(Boolean)
        : Array.isArray(account)
          ? account
          : [account];
    const match = reused ? account : await findRowOnList(serial, account);
    if (!match) {
        log('FortiToken debug: tapAndCapture no row for ' + JSON.stringify(names));
        return null;
    }

    const hint = bestOcrHint(match, names.concat(opts.aliases || []));
    log(
        'FortiToken debug: tapAndCapture "' +
            (match.from || hint) +
            '" a11yHidden=' +
            Boolean(match.hidden) +
            ' hasCode=' +
            Boolean(match.code) +
            ' eye=' +
            (match.eye ? match.eye.x + ',' + match.eye.y : 'none') +
            ' allowEye=' +
            allowEye,
    );

    if (!match.code) {
        const ocrCode = await readCodeFromScreenshot(serial, match, names);
        log(
            'FortiToken debug: OCR(pre-eye) hint="' +
                hint +
                '" hit=' +
                Boolean(ocrCode) +
                ' len=' +
                (ocrCode ? String(ocrCode).length : 0),
        );
        if (ocrCode) {
            applyCode(match, ocrCode);
        }
    }

    if (!match.code) {
        await sleep(250);
        const retry = await readCodeFromScreenshot(serial, match, names);
        log(
            'FortiToken debug: OCR(retry) hint="' +
                hint +
                '" hit=' +
                Boolean(retry) +
                ' len=' +
                (retry ? String(retry).length : 0),
        );
        if (retry) {
            applyCode(match, retry);
        }
    }

    if (!match.code && allowEye && match.eye) {
        log(
            'FortiToken debug: no OCR digits -> tap dashes at ' +
                match.eye.x +
                ',' +
                match.eye.y,
        );
        await shellQuiet(serial, 'input tap ' + match.eye.x + ' ' + match.eye.y);
        await sleep(450);
        let afterPeek = await peekFortiToken(serial);
        if (/name_edittext|Edit name/i.test(afterPeek.xml || '')) {
            await leaveSettings(serial);
            afterPeek = await peekFortiToken(serial);
        }
        log(
            'FortiToken debug: after eye tap onList=' +
                Boolean(afterPeek.onScreen && afterPeek.accounts && afterPeek.accounts.length) +
                ' rows=' +
                ((afterPeek.accounts && afterPeek.accounts.length) || 0),
        );
        const shown = pickAccount(await dumpAccounts(serial), match.from);
        log(
            'FortiToken debug: after eye "' +
                (match.from || '') +
                '" a11yCode=' +
                Boolean(shown && shown.code) +
                ' stillHidden=' +
                Boolean(shown && shown.hidden),
        );
        if (shown && shown.code) {
            applyCode(match, shown.code);
        }
        if (shown && shown.eye) {
            match.eye = shown.eye;
        }
        if (!match.code) {
            const ocrAfterEye = await readCodeFromScreenshot(serial, match, names);
            log(
                'FortiToken debug: OCR(after-eye) hint="' +
                    hint +
                    '" hit=' +
                    Boolean(ocrAfterEye) +
                    ' len=' +
                    (ocrAfterEye ? String(ocrAfterEye).length : 0),
            );
            if (ocrAfterEye) {
                applyCode(match, ocrAfterEye);
            }
        }
    } else if (!match.code && !allowEye) {
        log('FortiToken debug: skip dash tap (digits already on screen; hint match failed)');
    }

    match.remainingSeconds = totpRemainingSeconds();
    match.body = match.from;
    match.time = match.remainingSeconds + 's left';
    return match;
}

async function shellQuiet(serial, command) {
    try {
        return await shell(serial, command);
    } catch (err) {
        const message = String((err && err.message) || err || '');
        if (/INJECT_EVENTS|SecurityException|injected/i.test(message)) {
            return '';
        }
        throw err;
    }
}

async function collectFortiTokenCodes(options = {}) {
    const log = typeof options.log === 'function' ? options.log : () => {};
    const device = await pickDevice(options.serial);
    await ensureFortiTokenAlive(device.serial, log);
    const queries = options.accounts || [];
    const pending = [];
    for (const account of queries) {
        const names = Array.isArray(account) ? account : [account];
        const match = syntheticAccountMatch(names);
        pending.push({ names, match, hint: bestOcrHint(match, names) });
    }

    const shot = path.join(os.tmpdir(), `scrcpy-sms-batch-${process.pid}.png`);
    let shotReady = false;
    let totpOnScreen = 0;
    let hiddenPrefixes = [];
    let analysis = emptyOcrAnalysis();

    function logDumpRows(visible) {
        log(
            'FortiToken debug: UI dump rows=' +
                visible.length +
                ' -> ' +
                visible
                    .map((item) => {
                        const eye = item.eye ? item.eye.x + ',' + item.eye.y : 'none';
                        return (
                            '"' +
                            item.from +
                            '" a11yHidden=' +
                            Boolean(item.hidden) +
                            ' hasCode=' +
                            Boolean(item.code) +
                            ' eye=' +
                            eye
                        );
                    })
                    .join(' | '),
        );
    }

    function logOcrDump(passName) {
        if (analysis && analysis.dump) {
            log('FortiToken debug: OCR lines (redacted) ' + analysis.dump);
            return;
        }
        log('FortiToken debug: OCR produced no text pass=' + passName);
    }

    async function captureAndOcr(passName, opts = {}) {
        // This clone phone rejects adb screencap. Capture the scrcpy video
        // window first; PrintWindow avoids Cursor overlapping the pixels.
        const usePhone = Boolean(opts.phone);
        const copyFromScreen = Boolean(opts.copyFromScreen);
        if (usePhone) {
            await screencapPng(device.serial, shot);
        } else if (copyFromScreen) {
            await captureScrcpyWindowPng(shot, ['-SkipPrintWindow']);
        } else {
            await captureScreenPng(device.serial, shot);
        }
        shotReady = true;
        let shotSize = 0;
        try {
            shotSize = fs.statSync(shot).size;
        } catch (_err) {
            shotSize = 0;
        }
        const source = usePhone ? 'phone' : copyFromScreen ? 'scrcpy-screen' : 'scrcpy';
        log(
            'FortiToken debug: screen capture ok bytes=' +
                shotSize +
                ' pass=' +
                passName +
                ' source=' +
                source,
        );
        analysis = await analyzeOcr(shot);
        totpOnScreen = analysis.totp;
        hiddenPrefixes = analysis.hidden;
        log('FortiToken debug: OCR totp codes visible on screen=' + totpOnScreen);
        if (hiddenPrefixes.length) {
            log('FortiToken debug: dashed/hidden rows=' + hiddenPrefixes.join(','));
        }
        applyOcrAnalysis(pending, analysis, log, passName);
        dropDuplicateOcrCodes(pending, log);
        const looks = ocrLooksLikeFortiToken(analysis);
        if (!looks && !usePhone && !copyFromScreen) {
            log('FortiToken debug: PrintWindow is not the token list; retry CopyFromScreen');
            logOcrDump(passName);
            await captureAndOcr(passName + '-screen', { copyFromScreen: true });
            return;
        }
        if (!looks && !usePhone) {
            log('FortiToken debug: scrcpy screenshot is not the token list; capturing the phone instead');
            logOcrDump(passName);
            try {
                await captureAndOcr(passName + '-phone', { phone: true });
                return;
            } catch (err) {
                log(
                    'FortiToken debug: phone screencap failed: ' +
                        String((err && err.message) || err || 'unknown') +
                        ' (this phone often rejects adb screencap)',
                );
            }
        }
        if (!looks || totpOnScreen === 0 || pending.some((item) => !item.match.code)) {
            logOcrDump(passName);
        }
    }

    const eyesTapped = new Set();

    function eyeKey(item) {
        return hintPrefix(item.hint) || hintPrefix(item.match && item.match.from) || item.hint;
    }

    async function tapHiddenEyes(reason, retried) {
        const toTap = pending.filter((item) => {
            if (!item.match.eye || !rowNeedsEye(item, totpOnScreen, hiddenPrefixes, analysis)) {
                return false;
            }
            const key = eyeKey(item);
            return key ? !eyesTapped.has(key) : true;
        });
        if (!toTap.length) {
            const want = pending.filter((item) => rowNeedsEye(item, totpOnScreen, hiddenPrefixes, analysis));
            if (!retried && want.some((item) => !item.match.eye)) {
                log('FortiToken debug: dump UI for dash coordinates so hidden rows can be opened');
                try {
                    const visible = await dumpAccounts(device.serial);
                    logDumpRows(visible);
                    attachDumpToPending(pending, visible);
                } catch (err) {
                    log(
                        'FortiToken debug: UI dump for eyes FAILED: ' +
                            String((err && err.message) || err || 'unknown'),
                    );
                }
                return tapHiddenEyes(reason, true);
            }
            return false;
        }
        log(
            'FortiToken debug: ' +
                reason +
                ' -> tap ' +
                toTap.length +
                '/' +
                pending.length +
                ' dash row(s) once',
        );
        for (const item of toTap) {
            const key = eyeKey(item);
            log(
                'FortiToken debug: tap dashes for "' +
                    item.match.from +
                    '" at ' +
                    item.match.eye.x +
                    ',' +
                    item.match.eye.y,
            );
            await shellQuiet(
                device.serial,
                'input tap ' + item.match.eye.x + ' ' + item.match.eye.y,
            );
            if (key) {
                eyesTapped.add(key);
            }
            await sleep(120);
        }
        await sleep(280);
        return true;
    }

    try {
        await captureAndOcr('pass1');
    } catch (err) {
        shotReady = false;
        log(
            'FortiToken debug: screen capture FAILED: ' +
                String((err && err.message) || err || 'unknown'),
        );
    }

    if (pending.every((item) => item.match.code)) {
        log('FortiToken debug: all accounts OCR ok -> skip dump and eye taps');
    } else {
        const needsOpen = pending.some((item) => rowNeedsEye(item, totpOnScreen, hiddenPrefixes, analysis));
        if (needsOpen) {
            await tapHiddenEyes(totpOnScreen === 0 ? 'OCR no digits on token list' : 'OCR dashed');
            if (!pending.every((item) => item.match.code)) {
                try {
                    await captureAndOcr('pass2');
                } catch (err) {
                    log(
                        'FortiToken debug: recapture after eye FAILED: ' +
                            String((err && err.message) || err || 'unknown'),
                    );
                }
            }
        }
    }

    if (!pending.every((item) => item.match.code)) {
        log('FortiToken debug: dump UI to confirm the list and which rows are hidden');
        let visible = [];
        try {
            visible = await dumpAccounts(device.serial);
        } catch (err) {
            log(
                'FortiToken debug: UI dump FAILED: ' +
                    String((err && err.message) || err || 'unknown'),
            );
        }
        logDumpRows(visible);
        attachDumpToPending(pending, visible);
        if (!visible.length) {
            log('FortiToken debug: FortiToken list not on screen -> launching');
            await launchFortiToken(device.serial);
            const afterLaunch = await peekFortiToken(device.serial);
            if (/name_edittext|Edit name/i.test(afterLaunch.xml || '')) {
                await leaveSettings(device.serial);
            }
            try {
                visible = await dumpAccounts(device.serial);
            } catch (err) {
                log(
                    'FortiToken debug: UI dump after launch FAILED: ' +
                        String((err && err.message) || err || 'unknown'),
                );
            }
            logDumpRows(visible);
            attachDumpToPending(pending, visible);
            try {
                await captureAndOcr('after-launch');
            } catch (err) {
                log(
                    'FortiToken debug: recapture after launch FAILED: ' +
                        String((err && err.message) || err || 'unknown'),
                );
            }
        }
        if (!pending.every((item) => item.match.code)) {
            const tapped = await tapHiddenEyes('dump hidden');
            if (tapped && !pending.every((item) => item.match.code)) {
                try {
                    await captureAndOcr('pass2');
                    log('FortiToken debug: after selective eye reveal OCR totp count=' + totpOnScreen);
                } catch (err) {
                    log(
                        'FortiToken debug: recapture after eye FAILED: ' +
                            String((err && err.message) || err || 'unknown'),
                    );
                }
            } else if (!tapped) {
                log(
                    'FortiToken debug: skip dash taps; rows are not marked hidden (OCR miss is not a hide)',
                );
            }
        }
    }

    if (pending.some((item) => !item.match.code) && shotReady) {
        try {
            await captureAndOcr('fresh');
        } catch (_err) {
            log('FortiToken debug: fresh capture/OCR failed');
        }
    }

    if (options.revealOnly) {
        const visible = pending.filter((item) => item.match && item.match.code).length;
        log(
            'FortiToken: keep-visible pass done (' +
                visible +
                '/' +
                pending.length +
                ' codes showing).',
        );
        try {
            fs.unlinkSync(shot);
        } catch (_err) {
            // ignore
        }
        return pending.map((item) => item.match).filter(Boolean);
    }

    const results = [];
    for (const item of pending) {
        let match = item.match;
        const names = item.names;
        const hint = item.hint;
        const prefix = hintPrefix(hint) || hintPrefix(match && match.from);
        const dashed =
            Boolean(prefix && hiddenPrefixes.includes(prefix)) ||
            rowNeedsEye(item, totpOnScreen, hiddenPrefixes, analysis);
        if (!match.code && totpRemainingSeconds() < MIN_LEFT_TO_POST && !dashed) {
            await waitForFreshWindow(PREFERRED_LEFT_TO_READ);
        }
        if (!match.code) {
            const alreadyTapped = Boolean(prefix && eyesTapped.has(prefix));
            const allowEye = dashed && Boolean(match && match.eye) && !alreadyTapped;
            log(
                'FortiToken debug: fallback tapAndCapture hint="' +
                    hint +
                    '" allowEye=' +
                    allowEye,
            );
            const captured = await tapAndCapture(
                device.serial,
                match && (match.eye || match.tap) ? match : names,
                log,
                { allowEye, aliases: names },
            );
            if (captured) {
                match = captured;
                if (allowEye && prefix) {
                    eyesTapped.add(prefix);
                }
            }
        }
        log(
            'FortiToken debug: result "' +
                (match && match.from ? match.from : hint) +
                '" code=' +
                Boolean(match && match.code) +
                ' len=' +
                (match && match.code ? String(match.code).length : 0),
        );
        if (match) {
            match.device = device;
            match.package = FTM_PACKAGE;
            match.source = 'fortitoken';
            match.remainingSeconds = totpRemainingSeconds();
            match.body = match.from;
            match.time = match.remainingSeconds + 's left';
            results.push(match);
            if (typeof options.onCaptured === 'function') {
                await options.onCaptured(match);
            }
        }
    }
    try {
        fs.unlinkSync(shot);
    } catch (_err) {
        // ignore
    }
    return results;
}
async function keepCodesVisible(options = {}) {
    return collectFortiTokenCodes(Object.assign({}, options, { revealOnly: true }));
}

module.exports = {
    collectFortiTokenCodes,
    keepCodesVisible,
    ensureFortiTokenAlive,
    totpRemainingSeconds,
    waitForFreshWindow,
    PREFERRED_LEFT_TO_READ,
    MIN_LEFT_TO_POST,
};

