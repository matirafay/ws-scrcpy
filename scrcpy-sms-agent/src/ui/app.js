const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');
const resultEl = document.getElementById('result');
const listEl = document.getElementById('list');
const pushStatusEl = document.getElementById('push-status');
let lastSms = null;
let lastSentCode = '';
let watchTimer = null;
let watchBusy = false;

function showError(message) {
    errorEl.hidden = !message;
    errorEl.textContent = message || '';
}

function shortCode() {
    const value = document.getElementById('shortcode').value.trim();
    return value === 'YOUR_SHORTCODE' ? '' : value;
}

function pushOptions() {
    return {
        url: document.getElementById('endpoint').value.trim(),
        apiKey: document.getElementById('token').value.trim(),
        automationShortCode: shortCode(),
        type: Number(document.getElementById('mfa-type').value),
        secretKey: document.getElementById('secret-key').value.trim(),
    };
}

async function persistConfig() {
    await window.smsAgent.saveConfig(pushOptions());
}

async function pushCurrent(force) {
    if (!lastSms) {
        throw new Error('Read messages first.');
    }
    if (!force && lastSms.code && lastSms.code === lastSentCode) {
        pushStatusEl.textContent = 'Already transmitted this OTP. Waiting for a new one.';
        return null;
    }
    await persistConfig();
    const result = await window.smsAgent.pushSms(lastSms, pushOptions());
    lastSentCode = lastSms.code || lastSentCode;
    pushStatusEl.textContent = `Transmitted OTP ${lastSentCode} (HTTP ${result.inbox.status}).`;
    return result;
}

function showMessage(sms) {
    document.getElementById('from').textContent = sms.from || '';
    document.getElementById('time').textContent = sms.time || '';
    document.getElementById('code').textContent = sms.code || '—';
    document.getElementById('body').textContent = sms.body || '';
}

function renderList(conversations, selected) {
    listEl.innerHTML = '';
    document.getElementById('list-title').textContent = `Today (${conversations.length})`;
    conversations.forEach((item, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'item' + (item.from === selected.from && item.body === selected.body ? ' active' : '');
        button.innerHTML =
            '<span class="item-top"><strong></strong><em></em></span>' +
            '<span class="item-body"></span>' +
            (item.code ? '<span class="item-code"></span>' : '');
        button.querySelector('strong').textContent = item.from || 'Unknown';
        button.querySelector('em').textContent = item.time || '';
        button.querySelector('.item-body').textContent = item.body || '';
        if (item.code) {
            button.querySelector('.item-code').textContent = 'Code ' + item.code;
        }
        button.addEventListener('click', () => {
            Array.from(listEl.children).forEach((el) => el.classList.remove('active'));
            button.classList.add('active');
            lastSms = Object.assign({}, lastSms || {}, item);
            showMessage(item);
        });
        listEl.appendChild(button);
        if (index === 0 && item.from === selected.from) {
            button.classList.add('active');
        }
    });
}

async function refreshDevice() {
    showError('');
    try {
        const devices = await window.smsAgent.listDevices();
        const ready = devices.filter((d) => d.state === 'device');
        if (!ready.length) {
            statusEl.textContent = 'No authorized phone found. Connect USB, allow debugging, keep scrcpy running.';
            return false;
        }
        const d = ready[0];
        statusEl.textContent = `Connected: ${d.model || d.serial} (${d.serial})`;
        return true;
    } catch (err) {
        statusEl.textContent = 'ADB not available.';
        showError(err.message || String(err));
        return false;
    }
}

async function readAndTransmit(forcePush) {
    const sms = await window.smsAgent.getLatestSms({
        verificationOnly: document.getElementById('otp').checked,
        lastDay: true,
    });
    lastSms = sms;
    const conversations = sms.conversations && sms.conversations.length ? sms.conversations : [sms];
    resultEl.hidden = false;
    showMessage(sms);
    renderList(conversations, sms);
    const shouldPush = forcePush || document.getElementById('auto-push').checked || document.getElementById('auto-watch').checked;
    if (shouldPush && document.getElementById('endpoint').value.trim()) {
        await pushCurrent(forcePush);
    }
}

function stopWatch() {
    if (watchTimer) {
        clearInterval(watchTimer);
        watchTimer = null;
    }
}

function startWatch() {
    stopWatch();
    if (!document.getElementById('auto-watch').checked) {
        return;
    }
    if (!shortCode()) {
        showError('Set automationShortCode, then auto transmit will pick the latest OTP and POST it.');
        return;
    }
    const seconds = Math.max(10, Number(document.getElementById('interval').value) || 15);
    pushStatusEl.textContent = `Auto transmit on. Checking every ${seconds}s.`;
    const tick = async () => {
        if (watchBusy || !document.getElementById('auto-watch').checked) {
            return;
        }
        watchBusy = true;
        try {
            showError('');
            await readAndTransmit(false);
        } catch (err) {
            pushStatusEl.textContent = err.message || String(err);
        } finally {
            watchBusy = false;
        }
    };
    tick();
    watchTimer = setInterval(tick, seconds * 1000);
}

document.getElementById('refresh').addEventListener('click', refreshDevice);

document.getElementById('scrcpy').addEventListener('click', async () => {
    showError('');
    try {
        const result = await window.smsAgent.startScrcpy();
        if (!result.ok) {
            showError(result.message);
            return;
        }
        statusEl.textContent = result.message;
    } catch (err) {
        showError(err.message || String(err));
    }
});

document.getElementById('sms').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    showError('');
    try {
        await readAndTransmit(true);
    } catch (err) {
        showError(err.message || String(err));
    } finally {
        button.disabled = false;
    }
});

document.getElementById('push').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    showError('');
    pushStatusEl.textContent = 'Pushing…';
    try {
        await pushCurrent(true);
    } catch (err) {
        pushStatusEl.textContent = '';
        showError(err.message || String(err));
    } finally {
        button.disabled = false;
    }
});

document.getElementById('auto-watch').addEventListener('change', () => {
    if (document.getElementById('auto-watch').checked) {
        startWatch();
    } else {
        stopWatch();
        pushStatusEl.textContent = 'Auto transmit off.';
    }
});

refreshDevice();

window.smsAgent.getConfig().then((config) => {
    document.getElementById('endpoint').value = config.url || '';
    document.getElementById('token').value = config.apiKey || '';
    document.getElementById('shortcode').value = config.automationShortCode || '';
    document.getElementById('mfa-type').value = config.type === undefined ? 0 : config.type;
    document.getElementById('secret-key').value = config.secretKey || '';
    if (document.getElementById('auto-watch').checked) {
        startWatch();
    }
});
