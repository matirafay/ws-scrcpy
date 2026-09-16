const { app, BrowserWindow, ipcMain, Tray, Menu, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { getLatestSms, listDevices } = require('./sms');
const { startScrcpy } = require('./scrcpy');
const { startWatch } = require('./watch');

const showUi = process.argv.includes('--ui');

function packagedAdb() {
    return path.join(process.resourcesPath, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
}

function seedConfig(userData) {
    const dest = path.join(userData, 'sms-agent-config.json');
    const bundled = path.join(process.resourcesPath, 'sms-agent-config.json');
    const local = path.join(__dirname, '..', 'sms-agent-config.json');
    const source = fs.existsSync(bundled) ? bundled : local;
    if (!fs.existsSync(source)) {
        return dest;
    }
    const incoming = JSON.parse(fs.readFileSync(source, 'utf8'));
    if (!fs.existsSync(dest)) {
        fs.copyFileSync(source, dest);
        return dest;
    }
    try {
        const existing = JSON.parse(fs.readFileSync(dest, 'utf8'));
        existing.targets = Array.isArray(incoming.targets) && incoming.targets.length ? incoming.targets : existing.targets;
        if (!existing.url) {
            existing.url = incoming.url;
        }
        if (!existing.apiKey) {
            existing.apiKey = incoming.apiKey;
        }
        fs.writeFileSync(dest, JSON.stringify(existing, null, 2));
    } catch (_err) {
        fs.copyFileSync(source, dest);
    }
    return dest;
}

function createStatusWindow() {
    const win = new BrowserWindow({
        width: 560,
        height: 420,
        backgroundColor: '#111318',
        autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    win.loadFile(path.join(__dirname, 'ui', 'status.html'));
    return win;
}

function createWindow() {
    const win = new BrowserWindow({
        width: 580,
        height: 920,
        backgroundColor: '#111318',
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    win.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

function registerIpc() {
    const { getConfig, saveConfig } = require('./config');
    const { pushSms } = require('./push');
    ipcMain.handle('list-devices', () => listDevices());
    ipcMain.handle('get-latest-sms', (_event, options) => getLatestSms(options || {}));
    ipcMain.handle('start-scrcpy', (_event, serial) => startScrcpy(serial));
    ipcMain.handle('get-config', () => getConfig());
    ipcMain.handle('save-config', (_event, config) => saveConfig(config || {}));
    ipcMain.handle('push-sms', (_event, sms, options) => pushSms(sms, options || {}));
}

if (!app.requestSingleInstanceLock()) {
    console.log('[sms-agent] Already running. Close the other instance first.');
    app.quit();
} else {
    app.whenReady().then(() => {
        const adb = packagedAdb();
        if (fs.existsSync(adb)) {
            process.env.ADB = adb;
        }
        process.env.SMS_AGENT_CONFIG_DIR = app.getPath('userData');
        seedConfig(app.getPath('userData'));
        const logFile = path.join(app.getPath('userData'), 'sms-agent.log');
        if (showUi) {
            registerIpc();
            createWindow();
            app.on('activate', () => {
                if (BrowserWindow.getAllWindows().length === 0) {
                    createWindow();
                }
            });
            return;
        }
        const statusWin = createStatusWindow();
        const log = (message) => {
            const line = new Date().toISOString() + ' ' + message + '\n';
            try {
                fs.appendFileSync(logFile, line);
            } catch (_err) {
                // Keep the agent running even if the log file cannot be written.
            }
            console.log('[sms-agent]', message);
            if (statusWin && !statusWin.isDestroyed()) {
                statusWin.webContents
                    .executeJavaScript(
                        'var el=document.getElementById("log"); if(el){ el.textContent = ' +
                            JSON.stringify(message) +
                            ' + "\\n" + el.textContent; }',
                    )
                    .catch(() => {});
            }
        };
        new BrowserWindow({ show: false, skipTaskbar: true, width: 1, height: 1 });
        startWatch({
            log,
        });
        try {
            const tray = new Tray(process.execPath);
            tray.setToolTip('Scrcpy SMS Agent');
            tray.setContextMenu(
                Menu.buildFromTemplate([
                    { label: 'FortiToken: CC tmalik · CM jjilani · CIS mmehmood', enabled: false },
                    { label: 'Open log', click: () => shell.openPath(logFile) },
                    { type: 'separator' },
                    { label: 'Quit', click: () => app.quit() },
                ]),
            );
        } catch (_err) {
            // Tray is optional; the hidden window keeps the agent alive.
        }
    });

    app.on('window-all-closed', () => {
        if (showUi && process.platform !== 'darwin') {
            app.quit();
        }
    });
}
