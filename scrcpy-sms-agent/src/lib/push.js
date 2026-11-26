const { DEFAULT_URL, DEFAULT_API_KEY, MFA_TYPE_SMS, MFA_TYPE_TOTP } = require('./defaults');
const { getConfig } = require('./config');

function trimUrl(url) {
    return String(url || '')
        .trim()
        .replace(/([^:]\/)\/+/g, '$1');
}

function isRingCentral(sms) {
    return Boolean(sms && (sms.source === 'ringcentral' || sms.package === 'com.glip.mobile'));
}

function isAuthenticator(sms) {
    return Boolean(sms && (sms.source === 'authenticator' || sms.package === 'com.google.android.apps.authenticator2'));
}

function isFortiToken(sms) {
    return Boolean(sms && (sms.source === 'fortitoken' || sms.package === 'com.fortinet.android.ftm'));
}

function resolveType(sms, options, saved) {
    if (isAuthenticator(sms) || isRingCentral(sms) || isFortiToken(sms)) {
        return MFA_TYPE_SMS; // HealthForce stores these rows as SMS codes (type 1).
    }
    if (options.type !== undefined && options.type !== '') {
        return Number(options.type);
    }
    if (saved.type !== undefined && saved.type !== '') {
        return Number(saved.type);
    }
    return MFA_TYPE_TOTP;
}

function mfaPayload(sms, options = {}) {
    const code = String(sms.code || '');
    const type = Number(options.type);
    return {
        title: String(options.title || sms.from || ''),
        type: Number.isFinite(type) ? type : MFA_TYPE_TOTP,
        secretKey: String(options.secretKey || ''),
        smsCode: code,
        description: String(options.description || sms.body || ''),
        automationShortCode: String(options.automationShortCode || ''),
    };
}

// A post normally takes about a second (99% under 4.3s in the dev-PC test).
// Without a limit a dead connection is only reported after 10s. With 5s, a
// read that finished 2.5s into the window still gets a second try before 10s.
const POST_ATTEMPT_MS = 5000;
const POST_ATTEMPTS = 3;
const POST_RETRY_PAUSE_MS = 300;
const POST_MIN_ATTEMPT_MS = 1500;

function networkReason(err) {
    const cause = err && err.cause;
    const detail = cause && (cause.code || cause.name || cause.message);
    const message = String((err && err.message) || err || 'unknown');
    return detail && !message.includes(String(detail)) ? message + ' (' + detail + ')' : message;
}

async function postOnce(url, apiKey, body, timeoutMs) {
    const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            redirect: 'manual',
            signal: controller.signal,
        });
        const text = await response.text();
        return { status: response.status, text };
    } catch (err) {
        if (controller.signal.aborted) {
            const timeout = new Error('no answer from the endpoint within ' + Math.round(timeoutMs / 100) / 10 + 's');
            timeout.network = true;
            throw timeout;
        }
        const failed = new Error(networkReason(err));
        failed.network = true;
        throw failed;
    } finally {
        clearTimeout(timer);
    }
}

// Sends the code, trying again at once when the network does not answer. An
// HTTP error from the endpoint is not retried here: it is an answer.
// options.deadline (ms since epoch) is when the code stops being worth sending.
async function postJson(url, apiKey, body, options = {}) {
    const log = typeof options.log === 'function' ? options.log : () => {};
    const deadline = Number(options.deadline) || 0;
    let lastError = null;
    for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt += 1) {
        let timeoutMs = POST_ATTEMPT_MS;
        if (deadline) {
            const room = deadline - Date.now();
            if (attempt > 1 && room < POST_MIN_ATTEMPT_MS) {
                break;
            }
            timeoutMs = Math.max(POST_MIN_ATTEMPT_MS, Math.min(POST_ATTEMPT_MS, room));
        }
        try {
            const reply = await postOnce(url, apiKey, body, timeoutMs);
            if (reply.status < 200 || reply.status >= 300) {
                throw new Error(
                    'POST ' + url + ' -> HTTP ' + reply.status + (reply.text ? ': ' + reply.text.slice(0, 240) : ''),
                );
            }
            return { status: reply.status, body: reply.text.slice(0, 500), attempts: attempt };
        } catch (err) {
            if (!err || !err.network) {
                throw err;
            }
            lastError = err;
            log('Post attempt ' + attempt + ' of ' + POST_ATTEMPTS + ' failed: ' + err.message + '.');
            if (attempt < POST_ATTEMPTS) {
                await new Promise((resolve) => setTimeout(resolve, POST_RETRY_PAUSE_MS));
            }
        }
    }
    throw new Error('Could not reach the endpoint: ' + ((lastError && lastError.message) || 'unknown'));
}

async function pushSms(sms, options = {}) {
    const saved = getConfig();
    const url = trimUrl(options.url || saved.url || process.env.SMS_PUSH_URL || DEFAULT_URL);
    const apiKey = String(options.apiKey || options.token || saved.apiKey || process.env.SMS_PUSH_API_KEY || DEFAULT_API_KEY).trim();
    const payload = mfaPayload(sms, {
        title: options.title || saved.title,
        type: resolveType(sms, options, saved),
        secretKey: isRingCentral(sms) || isAuthenticator(sms) || isFortiToken(sms) ? '' : (options.secretKey !== undefined ? options.secretKey : saved.secretKey),
        description: options.description || saved.description,
        automationShortCode: options.automationShortCode || saved.automationShortCode,
    });
    if (!url) {
        throw new Error('Set the MFA endpoint URL.');
    }
    if (!apiKey) {
        throw new Error('Set the x-api-key.');
    }
    if (!payload.smsCode) {
        throw new Error('No SMS OTP found. Keep Prefer verification / OTP messages checked.');
    }
    if (!payload.automationShortCode) {
        throw new Error('Set automationShortCode.');
    }
    const posted = await postJson(url, apiKey, payload, { log: options.log, deadline: options.deadline });
    return {
        ok: true,
        attempts: posted.attempts,
        inbox: { url, status: posted.status, body: posted.body },
        payload: { title: payload.title, type: payload.type, smsCode: payload.smsCode, automationShortCode: payload.automationShortCode },
    };
}

module.exports = { pushSms };
