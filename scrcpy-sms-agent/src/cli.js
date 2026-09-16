#!/usr/bin/env node
const { getLatestSms, listDevices } = require('./services/sms');

async function main() {
    const verificationOnly = process.argv.includes('--otp');
    const devices = await listDevices();
    console.log(JSON.stringify({ devices, sms: await getLatestSms({ verificationOnly }) }, null, 2));
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
