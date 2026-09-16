# Scrcpy SMS Agent

Desktop agent that reads FortiToken codes from a USB phone (via scrcpy/ADB) and posts them to HealthForce at the start of each 30s window.

Runtime config lives in `%AppData%\scrcpy-sms-agent\sms-agent-config.json`. Copy `config.example.json` as a starting point; do not commit real keys.

## Layout

```
scrcpy-sms-agent/
  config.example.json
  package.json
  scripts/                 PowerShell helpers (OCR, capture, window lock)
  src/
    main.js                Electron entry
    preload.js
    cli.js
    mcp-server.js
    lib/                   Shared config, ADB, HealthForce push
    services/              Phone readers (FortiToken, SMS, scrcpy, …)
    watch/                 30s scheduler
    ui/                    Settings / status windows
```

## Run

The production build is **Scrcpy SMS Agent** under `%LocalAppData%\Programs`. Leave the scrcpy phone window open; the agent reads that window and posts on its own.

## Build installer

Put Windows `platform-tools` (at least `adb.exe`) in `vendor/platform-tools/`, then:

```shell
cd scrcpy-sms-agent
npm install
npm run dist
```

The NSIS installer is written to `dist/`. A fresh install already contains `src/lib`, `src/services`, `src/watch`, and `scripts`. Runtime keys stay in `%AppData%`; they are not packaged.
