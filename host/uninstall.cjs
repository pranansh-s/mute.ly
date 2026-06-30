#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOST_NAME = 'com.mutely.host';

const dirs = manifestDirs();
let removed = 0;

for (const dir of dirs) {
  const filePath = path.join(dir, `${HOST_NAME}.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    console.log(`[mutely] Removed: ${filePath}`);
    removed++;
  }
}

const installRoot = computeInstallRoot();
if (fs.existsSync(installRoot)) {
  fs.rmSync(installRoot, { recursive: true, force: true });
  console.log(`[mutely] Removed install dir: ${installRoot}`);
}

const legacyLauncher = path.resolve(__dirname, 'mutely-host-launcher.sh');
if (fs.existsSync(legacyLauncher)) {
  fs.unlinkSync(legacyLauncher);
  console.log(`[mutely] Removed legacy in-repo launcher: ${legacyLauncher}`);
}
const legacyBat = path.resolve(__dirname, 'mutely-host-launcher.bat');
if (fs.existsSync(legacyBat)) {
  fs.unlinkSync(legacyBat);
  console.log(`[mutely] Removed legacy in-repo launcher: ${legacyBat}`);
}

if (process.platform === 'win32') {
  spawnSync('reg', [
    'delete',
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
    '/f',
  ], { stdio: 'inherit' });
}

if (removed === 0 && process.platform !== 'win32') {
  console.log('[mutely] No manifest files found.');
}

function computeInstallRoot() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Mutely', 'bin');
  if (process.platform === 'win32') return path.join(home, 'AppData', 'Local', 'Mutely', 'bin');
  return path.join(home, '.local', 'share', 'mutely', 'bin');
}

function manifestDirs() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
      path.join(home, 'Library/Application Support/Google/Chrome Beta/NativeMessagingHosts'),
      path.join(home, 'Library/Application Support/Google/Chrome Canary/NativeMessagingHosts'),
      path.join(home, 'Library/Application Support/Google/Chrome Dev/NativeMessagingHosts'),
      path.join(home, 'Library/Application Support/Chromium/NativeMessagingHosts'),
      path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts'),
      path.join(home, 'Library/Application Support/Microsoft Edge/NativeMessagingHosts'),
      path.join(home, 'Library/Application Support/Arc/User Data/NativeMessagingHosts'),
      path.join(home, 'Library/Application Support/Vivaldi/NativeMessagingHosts'),
    ];
  }
  if (process.platform === 'linux') {
    return [
      path.join(home, '.config/google-chrome/NativeMessagingHosts'),
      path.join(home, '.config/chromium/NativeMessagingHosts'),
      path.join(home, '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts'),
    ];
  }
  if (process.platform === 'win32') {
    return [path.join(home, 'AppData', 'Local', 'Mutely', 'NativeMessagingHosts')];
  }
  return [];
}
