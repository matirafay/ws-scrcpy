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

async function postJson(url, apiKey, body) {
    const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
    };
    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'manual',
    });
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) {
        throw new Error('POST ' + url + ' -> HTTP ' + response.status + (text ? ': ' + text.slice(0, 240) : ''));
    }
    return { status: response.status, body: text.slice(0, 500) };
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
    const posted = await postJson(url, apiKey, payload);
    return {
        ok: true,
        inbox: { url, status: posted.status, body: posted.body },
        payload: { title: payload.title, type: payload.type, smsCode: payload.smsCode, automationShortCode: payload.automationShortCode },
    };
}

module.exports = { pushSms, mfaPayload };
