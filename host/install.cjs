#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOST_NAME = 'com.mutely.host';
const SOURCE_HOST_SCRIPT = path.resolve(__dirname, 'mutely-host.cjs');
const TEMPLATE_PATH = path.resolve(__dirname, 'manifest', `${HOST_NAME}.json`);

const INSTALL_ROOT = computeInstallRoot();
const INSTALLED_HOST_SCRIPT = path.join(INSTALL_ROOT, 'mutely-host.cjs');
const INSTALLED_LAUNCHER = path.join(INSTALL_ROOT, process.platform === 'win32' ? 'mutely-host-launcher.bat' : 'mutely-host-launcher.sh');

function computeInstallRoot() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Mutely', 'bin');
  if (process.platform === 'win32') return path.join(home, 'AppData', 'Local', 'Mutely', 'bin');
  return path.join(home, '.local', 'share', 'mutely', 'bin');
}

const extensionId = parseExtensionId(process.argv.slice(2));
if (!extensionId) {
  console.error('Usage: npm run install-host -- --extension-id=<EXTENSION_ID>');
  console.error('Get the ID from chrome://extensions after loading the unpacked dist/ folder.');
  process.exit(1);
}

checkDep('yt-dlp', ['--version']);
checkDep('ffmpeg', ['-version']);

if (!fs.existsSync(SOURCE_HOST_SCRIPT)) {
  console.error(`Host script missing: ${SOURCE_HOST_SCRIPT}`);
  process.exit(1);
}
if (!fs.existsSync(TEMPLATE_PATH)) {
  console.error(`Manifest template missing: ${TEMPLATE_PATH}`);
  process.exit(1);
}

fs.mkdirSync(INSTALL_ROOT, { recursive: true });
fs.copyFileSync(SOURCE_HOST_SCRIPT, INSTALLED_HOST_SCRIPT);
fs.chmodSync(INSTALLED_HOST_SCRIPT, 0o755);
console.log(`[mutely] Installed host: ${INSTALLED_HOST_SCRIPT}`);

const executablePath = ensureLauncher();
console.log(`[mutely] Installed launcher: ${executablePath}`);

const manifest = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
manifest.path = executablePath;
manifest.allowed_origins = [`chrome-extension://${extensionId}/`];

const targets = manifestTargets();
if (targets.length === 0) {
  console.error(`Unsupported platform: ${process.platform}`);
  process.exit(1);
}

for (const target of targets) {
  fs.mkdirSync(target.dir, { recursive: true });
  const filePath = path.join(target.dir, `${HOST_NAME}.json`);
  fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2));
  console.log(`[mutely] Installed manifest: ${filePath} (${target.browser})`);
  if (target.registry) registerWindowsHost(filePath);
}

console.log('[mutely] Done. Reload the extension at chrome://extensions and open any YouTube video.');

function parseExtensionId(args) {
  for (const arg of args) {
    if (arg.startsWith('--extension-id=')) return arg.slice('--extension-id='.length).trim();
    if (arg === '--extension-id') {
      const next = args[args.indexOf(arg) + 1];
      if (next) return next.trim();
    }
  }
  return process.env.MUTELY_EXTENSION_ID || null;
}

function checkDep(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'ignore' });
  if (result.error || result.status !== 0) {
    console.error(`[mutely] Missing dependency on PATH: ${cmd}`);
    console.error('  macOS:   brew install yt-dlp ffmpeg');
    console.error('  Linux:   sudo apt install yt-dlp ffmpeg');
    console.error('  Windows: winget install yt-dlp.yt-dlp ffmpeg');
    process.exit(1);
  }
}

function ensureLauncher() {
  const nodeBin = process.execPath;
  const pathExt = extraPathDirs().join(path.delimiter);

  if (process.platform === 'win32') {
    const setPath = pathExt ? `set PATH=${pathExt};%PATH%\r\n` : '';
    fs.writeFileSync(INSTALLED_LAUNCHER, `@echo off\r\n${setPath}"${nodeBin}" "${INSTALLED_HOST_SCRIPT}" %*\r\n`);
    return INSTALLED_LAUNCHER;
  }

  const exportPath = pathExt ? `export PATH="${pathExt}:$PATH"\n` : '';
  fs.writeFileSync(INSTALLED_LAUNCHER, `#!/bin/sh\n${exportPath}exec "${nodeBin}" "${INSTALLED_HOST_SCRIPT}" "$@"\n`);
  fs.chmodSync(INSTALLED_LAUNCHER, 0o755);
  if (process.platform === 'darwin') {
    stripQuarantine(INSTALLED_LAUNCHER);
    stripQuarantine(INSTALLED_HOST_SCRIPT);
  }
  return INSTALLED_LAUNCHER;
}

function stripQuarantine(filePath) {
  const result = spawnSync('xattr', ['-d', 'com.apple.quarantine', filePath], { stdio: 'ignore' });
  if (result.status === 0) console.log(`[mutely] Stripped com.apple.quarantine from ${filePath}`);
}

function extraPathDirs() {
  const dirs = new Set();
  for (const cmd of ['yt-dlp', 'ffmpeg']) {
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
    const found = (which.stdout || '').trim().split(/\r?\n/).filter(Boolean)[0];
    if (found) dirs.add(path.dirname(found));
  }
  dirs.add(path.dirname(process.execPath));
  return Array.from(dirs);
}

function manifestTargets() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      { browser: 'Chrome',        dir: path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts') },
      { browser: 'Chrome Beta',   dir: path.join(home, 'Library/Application Support/Google/Chrome Beta/NativeMessagingHosts') },
      { browser: 'Chrome Canary', dir: path.join(home, 'Library/Application Support/Google/Chrome Canary/NativeMessagingHosts') },
      { browser: 'Chrome Dev',    dir: path.join(home, 'Library/Application Support/Google/Chrome Dev/NativeMessagingHosts') },
      { browser: 'Chromium',      dir: path.join(home, 'Library/Application Support/Chromium/NativeMessagingHosts') },
      { browser: 'Brave',         dir: path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts') },
      { browser: 'Edge',          dir: path.join(home, 'Library/Application Support/Microsoft Edge/NativeMessagingHosts') },
      { browser: 'Arc',           dir: path.join(home, 'Library/Application Support/Arc/User Data/NativeMessagingHosts') },
      { browser: 'Vivaldi',       dir: path.join(home, 'Library/Application Support/Vivaldi/NativeMessagingHosts') },
    ];
  }
  if (process.platform === 'linux') {
    return [
      { browser: 'Chrome',  dir: path.join(home, '.config/google-chrome/NativeMessagingHosts') },
      { browser: 'Chromium', dir: path.join(home, '.config/chromium/NativeMessagingHosts') },
      { browser: 'Brave',   dir: path.join(home, '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts') },
    ];
  }
  if (process.platform === 'win32') {
    const dir = path.join(os.homedir(), 'AppData', 'Local', 'Mutely', 'NativeMessagingHosts');
    return [{ browser: 'Chrome (Windows)', dir, registry: true }];
  }
  return [];
}

function registerWindowsHost(manifestPath) {
  const result = spawnSync('reg', [
    'add',
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
    '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f',
  ], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('[mutely] Failed to register Chrome registry key. Run install as Administrator or add manually.');
    process.exit(1);
  }
}
