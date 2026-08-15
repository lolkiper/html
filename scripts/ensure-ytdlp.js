'use strict';

/**
 * Скачивает официальный бинарник yt-dlp в vendor/yt-dlp.
 *
 *   node scripts/ensure-ytdlp.js
 */

const fs = require('fs');
const https = require('https');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'yt-dlp');

function binaryName(platform = process.platform) {
  if (platform === 'win32') return 'yt-dlp.exe';
  if (platform === 'darwin') return 'yt-dlp_macos';
  return 'yt-dlp';
}

function downloadUrl(platform = process.platform) {
  const name = binaryName(platform);
  return `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${name}`;
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
            reject(new Error(`Скачивание yt-dlp: HTTP ${res.statusCode}`));
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

function works(bin) {
  try {
    const version = execFileSync(bin, ['--version'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return String(version || '').trim();
  } catch {
    return null;
  }
}

async function main() {
  fs.mkdirSync(VENDOR, { recursive: true });
  const dest = path.join(VENDOR, binaryName());
  const existing = works(dest);
  if (existing) {
    console.log(`yt-dlp уже на месте: ${dest} (${existing})`);
    return dest;
  }

  const url = downloadUrl();
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

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { main, binaryName, downloadUrl, VENDOR };
