const { getLatestFortiToken, listFortiTokenAccounts } = require('./fortitoken');
const { pushSms } = require('./push');
const { getConfig } = require('./config');

function startFortiTokenRefresh(options = {}) {
    const intervalMs =
        Math.max(30, Number(options.intervalSeconds || process.env.FORTITOKEN_REFRESH_SECONDS || 55)) * 1000;
    const log = options.log || ((message) => console.log(message));
    let busy = false;
    let lastSent = '';

    async function tick() {
        if (busy) {
            return;
        }
        busy = true;
        try {
            const account = options.account || getConfig().fortitokenAccount || 'mahmood';
            const listed = await listFortiTokenAccounts({ serial: options.serial, account });
            const match =
                listed.match ||
                listed.accounts.find((item) => item.from.toLowerCase().includes(String(account).toLowerCase())) ||
                listed.accounts[0];
            if (!match) {
                log('FortiToken token not found after open.');
                return;
            }
            if (listed.reason === 'tapped') {
                log('FortiToken ' + match.from + ': tapped the code (not the timer or chevron).');
            } else if (listed.reason === 'opened') {
                log('FortiToken ' + match.from + ': opened the token list.');
            }

            if (!match.hasCode) {
                log('FortiToken ' + match.from + ': USB still cannot copy the digits, so HealthForce was not updated.');
                return;
            }

            const totp = await getLatestFortiToken({
                serial: options.serial,
                account,
                waitForChange: false,
            });
            if (!totp.code || totp.code === lastSent) {
                log('FortiToken ' + match.from + ': readable code is already the last one posted.');
                return;
            }
            const result = await pushSms(totp, getConfig());
            lastSent = totp.code;
            log('Posted ' + totp.from + ' to HealthForce (HTTP ' + result.inbox.status + '). Refresh the staging record.');
        } catch (err) {
            log(err.message || String(err));
        } finally {
            busy = false;
        }
    }

    log('FortiToken watch: tap the code, then POST mahmood to HealthForce. Ctrl+C stops.');
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
}

if (require.main === module) {
    startFortiTokenRefresh();
}

module.exports = { startFortiTokenRefresh };
