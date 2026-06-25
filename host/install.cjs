#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOST_NAME = 'com.mutely.host';
const HOST_SCRIPT = path.resolve(__dirname, 'mutely-host.cjs');
const TEMPLATE_PATH = path.resolve(__dirname, 'manifest', `${HOST_NAME}.json`);
const LAUNCHER_PATH = path.resolve(__dirname, 'mutely-host-launcher');

const extensionId = parseExtensionId(process.argv.slice(2));
if (!extensionId) {
  console.error('Usage: npm run install-host -- --extension-id=<EXTENSION_ID>');
  console.error('Get the ID from chrome://extensions after loading the unpacked dist/ folder.');
  process.exit(1);
}

checkDep('yt-dlp', ['--version']);
checkDep('ffmpeg', ['-version']);

if (!fs.existsSync(HOST_SCRIPT)) {
  console.error(`Host script missing: ${HOST_SCRIPT}`);
  process.exit(1);
}
if (!fs.existsSync(TEMPLATE_PATH)) {
  console.error(`Manifest template missing: ${TEMPLATE_PATH}`);
  process.exit(1);
}

const executablePath = ensureLauncher();
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
  if (process.platform === 'win32') {
    const batPath = LAUNCHER_PATH + '.bat';
    fs.writeFileSync(batPath, `@echo off\r\nnode "${HOST_SCRIPT}" %*\r\n`);
    return batPath;
  }

  const shPath = LAUNCHER_PATH + '.sh';
  fs.writeFileSync(shPath, `#!/usr/bin/env bash\nexec node "${HOST_SCRIPT}" "$@"\n`);
  fs.chmodSync(shPath, 0o755);
  fs.chmodSync(HOST_SCRIPT, 0o755);
  return shPath;
}

function manifestTargets() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      { browser: 'Chrome',  dir: path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts') },
      { browser: 'Brave',   dir: path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts') },
      { browser: 'Edge',    dir: path.join(home, 'Library/Application Support/Microsoft Edge/NativeMessagingHosts') },
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
