const fs = require('node:fs');
const cp = require('node:child_process');
const { chromium } = require('/probe/node_modules/@playwright/test');
const report = {
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  modules: process.versions.modules,
  playwright: require('/probe/node_modules/@playwright/test/package.json').version,
  os: fs.readFileSync('/etc/os-release', 'utf8'),
  executable: chromium.executablePath(),
  browsersRoot: process.env.PLAYWRIGHT_BROWSERS_PATH,
  probes: [],
};
(async () => {
  for (const options of [{ headless: true }, { channel: 'chrome', headless: true }]) {
    try {
      const browser = await chromium.launch({ ...options, timeout: 30000, args: ['--no-sandbox'] });
      const page = await browser.newPage();
      await page.setContent('<title>GEA environment probe</title><p>ready</p>');
      report.probes.push({ options, status: 'passed', browserVersion: browser.version(), title: await page.title() });
      await browser.close();
    } catch (error) {
      report.probes.push({ options, status: 'failed', error: error.message });
    }
  }
  try {
    const pty = require('/probe/node_modules/node-pty');
    report.native = await new Promise((resolve, reject) => {
      const terminal = pty.spawn('/bin/sh', ['-c', 'printf GEA_NATIVE_READY'], { cols: 80, rows: 24 });
      let output = '';
      const timeout = setTimeout(() => { terminal.kill(); reject(Error('native probe timeout')); }, 10000);
      terminal.onData(data => { output += data; });
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        resolve({ status: exitCode === 0 && output.includes('GEA_NATIVE_READY') ? 'passed' : 'failed', exitCode, output });
      });
    });
  } catch (error) {
    report.native = { status: 'failed', error: error.message };
  }
  report.directAdoption = {
    nodeMatches: process.version === 'v24.22.0',
    browsersStayInOwnedRoot: report.executable.startsWith('/work/.quality-browser/'),
    chromiumLaunch: report.probes[0].status,
    systemChromeLaunch: report.probes[1].status,
    native: report.native.status,
  };
  report.verdict = Object.values(report.directAdoption).every(value => value === true || value === 'passed') ? 'candidate-compatible' : 'candidate-rejected';
  fs.writeFileSync('/evidence/image-probe.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
