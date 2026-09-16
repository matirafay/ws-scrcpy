#!/usr/bin/env node
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { getLatestSms, listDevices, openSmsApp, readSmsUi } = require('./services/sms');
const { getLatestRingCentral, openRingCentral } = require('./services/ringcentral');
const { getLatestAuthenticator, openAuthenticator } = require('./services/authenticator');
const { startScrcpy } = require('./services/scrcpy');

function asText(data) {
    return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
}

function asError(err) {
    return {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true,
    };
}

async function main() {
    const server = new McpServer({
        name: 'scrcpy-sms',
        version: '1.0.0',
    });

    server.tool(
        'list_devices',
        'List Android devices connected over ADB (the same USB/TCP connection scrcpy uses).',
        async () => {
            try {
                return asText(await listDevices());
            } catch (err) {
                return asError(err);
            }
        },
    );

    server.tool(
        'start_scrcpy',
        'Start the native scrcpy window for the connected phone, if scrcpy.exe is installed.',
        { serial: z.string().optional() },
        async ({ serial }) => {
            try {
                return asText(await startScrcpy(serial));
            } catch (err) {
                return asError(err);
            }
        },
    );

    server.tool(
        'open_sms_app',
        'Open the SMS / Google Messages app on the connected phone.',
        { serial: z.string().optional() },
        async ({ serial }) => {
            try {
                const result = await openSmsApp(serial);
                return asText({
                    ok: true,
                    package: result.package,
                    device: result.device,
                });
            } catch (err) {
                return asError(err);
            }
        },
    );

    server.tool(
        'read_sms_ui',
        'Dump the current SMS app UI and return visible conversations and text.',
        { serial: z.string().optional() },
        async ({ serial }) => {
            try {
                const ui = await readSmsUi(serial);
                return asText({
                    device: ui.device,
                    conversations: ui.conversations,
                    thread: ui.thread || null,
                });
            } catch (err) {
                return asError(err);
            }
        },
    );

    server.tool(
        'get_latest_sms',
        'Open the phone SMS app over ADB/scrcpy and return messages from today. Set verificationOnly to prefer OTP/verification texts. Set lastDay to false to return the full visible inbox.',
        {
            serial: z.string().optional(),
            verificationOnly: z.boolean().optional(),
            lastDay: z.boolean().optional(),
        },
        async ({ serial, verificationOnly, lastDay }) => {
            try {
                return asText(await getLatestSms({ serial, verificationOnly, lastDay }));
            } catch (err) {
                return asError(err);
            }
        },
    );

    server.tool(
        'push_latest_sms',
        'Read today\'s SMS from the phone and POST the selected OTP to UpdateExternalMFACode (SMS_PUSH_URL / x-api-key).',
        {
            serial: z.string().optional(),
            verificationOnly: z.boolean().optional(),
            lastDay: z.boolean().optional(),
            url: z.string().optional(),
            apiKey: z.string().optional(),
            token: z.string().optional(),
            automationShortCode: z.string().optional(),
            type: z.number().optional(),
            secretKey: z.string().optional(),
        },
        async ({ serial, verificationOnly, lastDay, url, apiKey, token, automationShortCode, type, secretKey }) => {
            try {
                const { pushSms } = require('./lib/push');
                const sms = await getLatestSms({ serial, verificationOnly: verificationOnly !== false, lastDay });
                const pushed = await pushSms(sms, { url, apiKey: apiKey || token, automationShortCode, type, secretKey });
                return asText({ sms: { from: sms.from, time: sms.time, code: sms.code, count: sms.conversations.length }, pushed });
            } catch (err) {
                return asError(err);
            }
        },
    );

    server.tool(
        'open_ringcentral',
        'Open the RingCentral app on the connected phone and switch to the Text tab.',
        { serial: z.string().optional() },
        async ({ serial }) => {
            try {
                const result = await openRingCentral(serial);
                return asText({ ok: true, package: result.package, device: result.device });
            } catch (err) {
                return asError(err);
            }
        },
    );

    server.tool(
        'get_latest_ringcentral',
        'Open RingCentral Text and return today\'s visible texts. Set verificationOnly to prefer OTP/verification texts. Set lastDay to false for the full visible list.',
        {
            serial: z.string().optional(),
            verificationOnly: z.boolean().optional(),
            lastDay: z.boolean().optional(),
        },
        async ({ serial, verificationOnly, lastDay }) => {
            try {
                return asText(await getLatestRingCentral({ serial, verificationOnly, lastDay }));
            } catch (err) {
                return asError(err);
            }
        },
    );

    server.tool(
        'open_authenticator',
        'Open Google Authenticator on the connected phone.',
        { serial: z.string().optional() },
        async ({ serial }) => {
            try {
                const result = await openAuthenticator(serial);
                return asText({ ok: true, package: result.package, device: result.device });
            } catch (err) {
                return asError(err);
            }
        },
    );

    server.tool(
        'get_latest_authenticator',
        'Open Google Authenticator and return visible TOTP accounts and current codes. Optionally filter by account name substring.',
        {
            serial: z.string().optional(),
            account: z.string().optional(),
        },
        async ({ serial, account }) => {
            try {
                const result = await getLatestAuthenticator({ serial, account });
                return asText({
                    from: result.from,
                    code: result.code,
                    source: result.source,
                    accounts: result.conversations.map((item) => ({ from: item.from, code: item.code })),
                });
            } catch (err) {
                return asError(err);
            }
        },
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
