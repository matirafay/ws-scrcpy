const fs = require('fs');
const path = require('path');
const { DEFAULT_URL, DEFAULT_API_KEY, DEFAULT_TARGETS } = require('./defaults');

function configPath() {
    const dir = process.env.SMS_AGENT_CONFIG_DIR || process.cwd();
    return path.join(dir, 'sms-agent-config.json');
}

function getConfig() {
    const fallback = {
        url: process.env.SMS_PUSH_URL || DEFAULT_URL,
        apiKey: process.env.SMS_PUSH_API_KEY || DEFAULT_API_KEY,
        type: 0,
        secretKey: '',
        title: '',
        description: '',
        automationShortCode: process.env.SMS_PUSH_SHORTCODE || 'YOUR_SHORTCODE',
        authenticatorAccount: process.env.SMS_AUTHENTICATOR_ACCOUNT || 'tmalik',
        fortitokenAccount: process.env.SMS_FORTITOKEN_ACCOUNT || 'mahmood',
        targets: DEFAULT_TARGETS,
    };
    try {
        const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
        const targets = Array.isArray(raw.targets) && raw.targets.length ? raw.targets : fallback.targets;
        return {
            url: String(raw.url || fallback.url),
            apiKey: String(raw.apiKey || fallback.apiKey),
            type: raw.type === undefined || raw.type === '' ? fallback.type : Number(raw.type),
            secretKey: String(raw.secretKey || ''),
            title: String(raw.title || ''),
            description: String(raw.description || ''),
            automationShortCode: String(raw.automationShortCode || fallback.automationShortCode),
            authenticatorAccount: String(raw.authenticatorAccount || fallback.authenticatorAccount),
            fortitokenAccount: String(raw.fortitokenAccount || fallback.fortitokenAccount),
            targets,
        };
    } catch (_err) {
        return fallback;
    }
}

function saveConfig(config) {
    const current = getConfig();
    const next = {
        url: String((config && config.url) || current.url || DEFAULT_URL).trim() || DEFAULT_URL,
        apiKey: String((config && (config.apiKey || config.token)) || current.apiKey || DEFAULT_API_KEY).trim(),
        type: Number(config && config.type !== undefined ? config.type : current.type) || 0,
        secretKey: String((config && config.secretKey) || current.secretKey || ''),
        title: String((config && config.title) || current.title || ''),
        description: String((config && config.description) || current.description || ''),
        automationShortCode: String((config && config.automationShortCode) || current.automationShortCode || ''),
        authenticatorAccount: String((config && config.authenticatorAccount) || current.authenticatorAccount || ''),
        fortitokenAccount: String((config && config.fortitokenAccount) || current.fortitokenAccount || ''),
        targets: Array.isArray(config && config.targets) && config.targets.length ? config.targets : current.targets,
    };
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2));
    return next;
}

module.exports = { getConfig, saveConfig, configPath };
