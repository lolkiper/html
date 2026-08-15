'use strict';

/**
 * Скачивает yt-dlp, Deno (JS runtime YouTube) и aria2c (как Media Downloader)
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

function aria2Name(platform = process.platform) {
  return platform === 'win32' ? 'aria2c.exe' : 'aria2c';
}

function aria2ArchiveUrl(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') {
    return 'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip';
  }
  if (platform === 'darwin') {
    return null;
  }
  if (arch === 'arm64') return null;
  return 'https://github.com/q3aql/aria2-static-builds/releases/download/v1.37.0/aria2-1.37.0-linux-gnu-64bit-build1.tar.bz2';
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

function extractArchive(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (/\.(tar\.bz2|tbz2)$/i.test(archive)) {
    execFileSync('tar', ['-xjf', archive, '-C', destDir], { stdio: 'pipe' });
    return;
  }
  if (process.platform === 'win32') {
    execFileSync('tar', ['-xf', archive, '-C', destDir], { stdio: 'pipe' });
    return;
  }
  try {
    execFileSync('unzip', ['-o', archive, '-d', destDir], { stdio: 'pipe' });
    return;
  } catch {
    execFileSync(
      'python3',
      ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', archive, destDir],
      { stdio: 'pipe' }
    );
  }
}

function findNamed(root, name) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === name) return full;
    }
  }
  return null;
}

function rmTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
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
  extractArchive(zip, VENDOR);
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

async function ensureAria2() {
  const dest = path.join(VENDOR, aria2Name());
  const existing = works(dest);
  if (existing) {
    console.log(`aria2c уже на месте: ${dest} (${existing})`);
    return dest;
  }
  const url = aria2ArchiveUrl();
  if (!url) {
    console.log('aria2c: для этой платформы архив не скачиваем, нужен системный aria2c');
    return null;
  }
  console.log(`Скачиваю ${url}`);
  const archive = path.join(VENDOR, path.basename(url));
  const extractDir = path.join(VENDOR, `.aria2-extract-${process.pid}`);
  rmTree(extractDir);
  fs.mkdirSync(extractDir, { recursive: true });
  await download(url, archive);
  extractArchive(archive, extractDir);
  safeUnlink(archive);
  const found = findNamed(extractDir, aria2Name());
  if (!found) {
    rmTree(extractDir);
    throw new Error(`В архиве aria2 нет файла ${aria2Name()}`);
  }
  fs.copyFileSync(found, dest);
  rmTree(extractDir);
  try {
    fs.chmodSync(dest, 0o755);
  } catch {
    /* Windows */
  }
  const version = works(dest);
  if (!version) throw new Error(`aria2c скачан, но не запускается: ${dest}`);
  console.log(`OK ${dest} (${version})`);
  return dest;
}

async function main() {
  fs.mkdirSync(VENDOR, { recursive: true });
  const ytdlp = await ensureYtDlp();
  const deno = await ensureDeno();
  const aria2 = await ensureAria2();
  return { ytdlp, deno, aria2 };
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
  aria2Name,
  VENDOR
};
