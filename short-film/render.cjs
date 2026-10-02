// 逐帧渲染：node render.js <outDir> [fps=30] [seconds=30] [workers=4]
// 或抽样预览：node render.js <outDir> --at 0.5,3,8.8,9.1
const path = require('path');
const fs = require('fs');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const outDir = process.argv[2];
const atIdx = process.argv.indexOf('--at');
const fps = atIdx < 0 ? +(process.argv[3] || 30) : 30;
const secs = atIdx < 0 ? +(process.argv[4] || 30) : 30;
const workers = atIdx < 0 ? +(process.argv[5] || 4) : 2;
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  const jobs = [];
  if (atIdx >= 0) process.argv[atIdx + 1].split(',').forEach(s => jobs.push({ t: +s, name: `at_${(+s).toFixed(2).padStart(5, '0')}.png` }));
  else for (let i = 0; i < fps * secs; i++) jobs.push({ t: i / fps, name: `f_${String(i).padStart(4, '0')}.png` });

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--no-sandbox', '--disable-gpu', '--force-color-profile=srgb'],
  }).catch(() => chromium.launch({ args: ['--no-sandbox', '--disable-gpu', '--force-color-profile=srgb'] }));

  let next = 0, done = 0; const t0 = Date.now();
  async function worker() {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    page.on('pageerror', e => { console.error('PAGE ERROR', e.message); });
    await page.goto('file://' + path.resolve(__dirname, 'film.html'));
    await page.evaluate(() => document.fonts.ready);
    while (true) {
      const j = jobs[next++]; if (!j) break;
      await page.evaluate(t => window.renderFrame(t), j.t);
      await page.screenshot({ path: path.join(outDir, j.name), type: 'png' });
      if (++done % 30 === 0) console.log(`${done}/${jobs.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    await page.close();
  }
  await Promise.all(Array.from({ length: workers }, worker));
  await browser.close();
  console.log('done', jobs.length, 'frames in', ((Date.now() - t0) / 1000).toFixed(1), 's');
})();
