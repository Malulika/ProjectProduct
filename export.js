#!/usr/bin/env node
/* =====================================================================
   export.js  —  frame-accurate export of index.html to PNG + MP4
   ---------------------------------------------------------------------
   Loads index.html in headless Chromium, calls window.seek(i / 360) for
   every frame, writes frames/frame_0000.png ... frame_0359.png, then
   stitches them with ffmpeg.

   The page renders synchronously inside seek() from the normalized time
   alone, so every frame is deterministic and reproducible.

     node export.js                 frames + video
     node export.js --no-video      frames only
     node export.js --skip-frames   stitch the frames already on disk
     node export.js --frames 120    render only the first 120 frames
     node export.js --scale 0.5     render at half size (quick preview)

   Env:
     PUPPETEER_EXECUTABLE_PATH   use an existing Chrome/Chromium binary
     FFMPEG_PATH                 use a specific ffmpeg binary
   ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT      = __dirname;
const PAGE      = path.join(ROOT, 'index.html');
const FRAME_DIR = path.join(ROOT, 'frames');
const OUT_FILE  = path.join(ROOT, 'out.mp4');
const FPS       = 30;

/* ------------------------------ arguments ------------------------------ */
function parseArgs(argv) {
  const o = { video: true, frames: true, count: null, scale: 1, crf: 18 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-video')         o.video = false;
    else if (a === '--skip-frames') o.frames = false;
    else if (a === '--frames')      o.count = parseInt(argv[++i], 10);
    else if (a === '--scale')       o.scale = parseFloat(argv[++i]);
    else if (a === '--crf')         o.crf = parseInt(argv[++i], 10);
    else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else { console.error('unknown option: ' + a); usage(); process.exit(1); }
  }
  return o;
}
function usage() {
  console.log('usage: node export.js [--no-video] [--skip-frames] ' +
              '[--frames N] [--scale S] [--crf N]');
}

const args = parseArgs(process.argv);

/* --------------------------- frame rendering --------------------------- */
async function renderFrames() {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (e) {
    console.error('puppeteer is not installed. Run:  npm install');
    process.exit(1);
  }

  fs.rmSync(FRAME_DIR, { recursive: true, force: true });
  fs.mkdirSync(FRAME_DIR, { recursive: true });

  const launch = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--allow-file-access-from-files',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      '--disable-lcd-text'
    ]
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launch.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const browser = await puppeteer.launch(launch);
  const page = await browser.newPage();

  page.on('pageerror', err => { console.error('page error:', err.message); });
  page.on('console', m => {
    if (m.type() === 'error') console.error('console:', m.text());
  });

  await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });
  /* no ?debug=1 -> the dev panel is never even created */
  await page.goto('file://' + PAGE, { waitUntil: 'load' });
  await page.waitForFunction('window.ready === true', { timeout: 60000 });

  const total = await page.evaluate('window.TOTAL_FRAMES');
  const n = args.count ? Math.min(args.count, total) : total;
  await page.evaluate('window.pause()');

  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    /* seek to the exact normalized time for this frame, then read the
       canvas back directly -- no screenshot, so the pixels are exactly
       what the page drew at 1080x1920 */
    const dataUrl = await page.evaluate((i, scale) => {
      window.seek(i / window.TOTAL_FRAMES);
      const src = document.getElementById('stage');
      if (scale === 1) return src.toDataURL('image/png');
      const c = document.createElement('canvas');
      c.width = Math.round(src.width * scale);
      c.height = Math.round(src.height * scale);
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(src, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    }, i, args.scale);

    const file = path.join(FRAME_DIR, 'frame_' + String(i).padStart(4, '0') + '.png');
    fs.writeFileSync(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));

    if (i % 30 === 0 || i === n - 1) {
      const pct = (((i + 1) / n) * 100).toFixed(0);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      process.stdout.write('\r  frame ' + String(i + 1).padStart(4) + '/' + n +
                           '  (' + pct + '%)  ' + secs + 's   ');
    }
  }
  process.stdout.write('\n');
  await browser.close();
  console.log('  wrote ' + n + ' frames to ' + path.relative(ROOT, FRAME_DIR) + '/');
}

/* ------------------------------- stitching ----------------------------- */
function findFfmpeg() {
  const candidates = [process.env.FFMPEG_PATH, 'ffmpeg'].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ['-version'], { stdio: 'ignore' });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

function encode() {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    console.error('\nffmpeg not found. Frames are on disk; stitch them with:\n');
    console.error('  ffmpeg -framerate 30 -i frames/frame_%04d.png ' +
                  '-c:v libx264 -pix_fmt yuv420p -crf 18 out.mp4\n');
    console.error('Install it with  brew install ffmpeg  /  apt install ffmpeg\n');
    process.exitCode = 1;
    return;
  }

  const ff = [
    '-y',
    '-framerate', String(FPS),
    '-i', path.join(FRAME_DIR, 'frame_%04d.png'),
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-crf', String(args.crf),
    '-movflags', '+faststart',
    OUT_FILE
  ];
  console.log('  ' + ffmpeg + ' ' + ff.join(' '));
  const r = spawnSync(ffmpeg, ff, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) {
    console.error('ffmpeg failed with status ' + r.status);
    process.exitCode = 1;
    return;
  }
  const mb = (fs.statSync(OUT_FILE).size / 1048576).toFixed(2);
  console.log('  wrote ' + path.relative(ROOT, OUT_FILE) + '  (' + mb + ' MB)');
}

/* --------------------------------- main -------------------------------- */
(async () => {
  if (args.frames) {
    console.log('rendering frames...');
    await renderFrames();
  }
  if (args.video) {
    console.log('encoding video...');
    encode();
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
