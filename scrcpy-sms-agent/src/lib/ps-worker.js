const fs = require('fs');
const { spawn } = require('child_process');
const { scriptFile } = require('./paths');

// One PowerShell session kept loaded for screenshots and OCR. A fresh
// powershell.exe per call costs 3-4 seconds each; reads that slow post codes
// late in the 30s window. Callers fall back to a fresh process when this
// helper is unavailable.
const START_TIMEOUT_MS = 20000;
const RECYCLE_AFTER = 400;

let worker = null;
let nextId = 1;
let chain = Promise.resolve();

class WorkerUnavailable extends Error {}

function stopWorker(reason) {
    const current = worker;
    worker = null;
    if (!current) {
        return;
    }
    if (current.pending) {
        current.pending.reject(new WorkerUnavailable(reason || 'worker stopped'));
        current.pending = null;
    }
    try {
        current.child.stdin.end();
    } catch (_err) {
        // already closed
    }
    try {
        current.child.kill();
    } catch (_err) {
        // already gone
    }
}

function startWorker() {
    const script = scriptFile('ps-worker.ps1');
    if (!fs.existsSync(script)) {
        return Promise.reject(new WorkerUnavailable('ps-worker.ps1 not found'));
    }
    return new Promise((resolve, reject) => {
        const child = spawn(
            'powershell.exe',
            ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', script],
            { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
        );
        const state = { child, pending: null, served: 0, buffer: '' };
        let ready = false;
        const startTimer = setTimeout(() => {
            if (!ready) {
                try {
                    child.kill();
                } catch (_err) {
                    // ignore
                }
                reject(new WorkerUnavailable('worker did not start in time'));
            }
        }, START_TIMEOUT_MS);
        child.stdout.on('data', (chunk) => {
            state.buffer += chunk.toString('utf8');
            let index = state.buffer.indexOf('\n');
            while (index >= 0) {
                const line = state.buffer.slice(0, index).replace(/\r$/, '');
                state.buffer = state.buffer.slice(index + 1);
                index = state.buffer.indexOf('\n');
                if (!ready && line.trim() === '@@READY') {
                    ready = true;
                    clearTimeout(startTimer);
                    worker = state;
                    resolve(state);
                    continue;
                }
                if (!line.startsWith('@@R ') || !state.pending) {
                    continue;
                }
                let reply = null;
                try {
                    reply = JSON.parse(line.slice(4));
                } catch (_err) {
                    reply = null;
                }
                if (!reply || reply.id !== state.pending.id) {
                    continue;
                }
                const pending = state.pending;
                state.pending = null;
                pending.resolve(reply);
            }
        });
        const gone = (why) => {
            clearTimeout(startTimer);
            if (!ready) {
                reject(new WorkerUnavailable(why));
            }
            if (worker === state) {
                stopWorker(why);
            } else if (state.pending) {
                state.pending.reject(new WorkerUnavailable(why));
                state.pending = null;
            }
        };
        child.on('error', (err) => gone('worker failed: ' + String((err && err.message) || err)));
        child.on('exit', () => gone('worker exited'));
    });
}

async function send(script, params, timeoutMs) {
    let state = worker;
    if (state && state.served >= RECYCLE_AFTER) {
        stopWorker('recycle');
        state = null;
    }
    if (!state) {
        state = await startWorker();
    }
    state.served += 1;
    const id = nextId++;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            // A stuck script would block every later read; start over next time.
            stopWorker('worker timed out');
            reject(new WorkerUnavailable('worker timed out'));
        }, timeoutMs || 20000);
        state.pending = {
            id,
            resolve: (reply) => {
                clearTimeout(timer);
                resolve(reply);
            },
            reject: (err) => {
                clearTimeout(timer);
                reject(err);
            },
        };
        try {
            state.child.stdin.write(JSON.stringify({ id, script, params: params || {} }) + '\n');
        } catch (err) {
            stopWorker('worker pipe closed');
        }
    });
}

// Runs scripts/<script> with named parameters inside the shared session.
// Resolves { ok, out, error } from the script itself. Rejects with
// WorkerUnavailable when the helper could not run it at all.
function runInWorker(script, params, timeoutMs) {
    const job = chain.then(() => send(script, params, timeoutMs));
    chain = job.catch(() => {});
    return job;
}

module.exports = { runInWorker, stopWorker, WorkerUnavailable };
