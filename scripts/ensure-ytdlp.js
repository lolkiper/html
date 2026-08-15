'use strict';

/**
 * Скачивает официальный бинарник yt-dlp и Deno (JS runtime для YouTube)
 * в vendor/yt-dlp.
 *
 *   node scripts/ensure-ytdlp.js
 */

const fs = require('fs');
const https = require('https');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'yt-dlp');

function ytdlpName(platform = process.platform) {
  if (platform === 'win32') return 'yt-dlp.exe';
  if (platform === 'darwin') return 'yt-dlp_macos';
  return 'yt-dlp';
}

function denoName(platform = process.platform) {
  return platform === 'win32' ? 'deno.exe' : 'deno';
}

function ytdlpUrl(platform = process.platform) {
  return `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytdlpName(platform)}`;
}

function denoZipName(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return 'deno-x86_64-pc-windows-msvc.zip';
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'deno-aarch64-apple-darwin.zip' : 'deno-x86_64-apple-darwin.zip';
  }
  return arch === 'arm64' ? 'deno-aarch64-unknown-linux-gnu.zip' : 'deno-x86_64-unknown-linux-gnu.zip';
}

function denoUrl(platform = process.platform, arch = process.arch) {
  return `https://github.com/denoland/deno/releases/latest/download/${denoZipName(platform, arch)}`;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (current) => {
      https
        .get(current, { headers: { 'User-Agent': 'shorts-inserter' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            follow(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Скачивание: HTTP ${res.statusCode} (${url})`));
            return;
          }
          const out = fs.createWriteStream(dest, { mode: 0o755 });
          res.pipe(out);
          out.on('finish', () => out.close(resolve));
          out.on('error', reject);
        })
        .on('error', reject);
    };
    follow(url);
  });
}

function works(bin, args = ['--version']) {
  try {
    const version = execFileSync(bin, args, {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return String(version || '').trim().split(/\r?\n/)[0];
  } catch {
    return null;
  }
}

function extractZip(zip, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync('tar', ['-xf', zip, '-C', destDir], { stdio: 'pipe' });
    return;
  }
  try {
    execFileSync('unzip', ['-o', zip, '-d', destDir], { stdio: 'pipe' });
    return;
  } catch {
    execFileSync(
      'python3',
      ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, destDir],
      { stdio: 'pipe' }
    );
  }
}

async function ensureYtDlp() {
  const dest = path.join(VENDOR, ytdlpName());
  const existing = works(dest);
  if (existing) {
    console.log(`yt-dlp уже на месте: ${dest} (${existing})`);
    return dest;
  }
  const url = ytdlpUrl();
  console.log(`Скачиваю ${url}`);
  const tmp = `${dest}.part`;
  await download(url, tmp);
  fs.renameSync(tmp, dest);
  try {
    fs.chmodSync(dest, 0o755);
  } catch {
    /* Windows */
  }
  const version = works(dest);
  if (!version) throw new Error(`yt-dlp скачан, но не запускается: ${dest}`);
  console.log(`OK ${dest} (${version})`);
  return dest;
}

async function ensureDeno() {
  const dest = path.join(VENDOR, denoName());
  const existing = works(dest);
  if (existing) {
    console.log(`deno уже на месте: ${dest} (${existing})`);
    return dest;
  }
  const url = denoUrl();
  console.log(`Скачиваю ${url}`);
  const zip = path.join(VENDOR, `${denoName()}.zip`);
  await download(url, zip);
  extractZip(zip, VENDOR);
  safeUnlink(zip);
  if (!fs.existsSync(dest)) {
    throw new Error(`В архиве Deno нет файла ${denoName()}`);
  }
  try {
    fs.chmodSync(dest, 0o755);
  } catch {
    /* Windows */
  }
  const version = works(dest);
  if (!version) throw new Error(`deno скачан, но не запускается: ${dest}`);
  console.log(`OK ${dest} (${version})`);
  return dest;
}

function safeUnlink(file) {
  try {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

async function main() {
  fs.mkdirSync(VENDOR, { recursive: true });
  const ytdlp = await ensureYtDlp();
  const deno = await ensureDeno();
  return { ytdlp, deno };
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  main,
  binaryName: ytdlpName,
  downloadUrl: ytdlpUrl,
  ytdlpName,
  denoName,
  VENDOR
};
