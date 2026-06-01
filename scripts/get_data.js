const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const XLSX = require('xlsx');

const DEFAULT_USERNAME = 'naming201@berkeley.edu';
const DEFAULT_PASSWORD = 'Solarpanel1';
const DEFAULT_STATION_ID = 'f421d697-3a6e-4e22-81cc-e25c6435ba7d';
const DEFAULT_REFRESH_DAYS = 3;
const CHART_JS_SOURCE = fs.readFileSync(
  path.join(path.dirname(require.resolve('chart.js/auto')), '..', 'dist', 'chart.umd.js'),
  'utf8'
);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function parseCli(argv) {
  const positional = [];
  const options = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    i += 1;
  }

  return { positional, options };
}

function parseYmd(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== Number(match[1]) ||
    date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3])
  ) {
    return null;
  }

  return date;
}

function formatYmd(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatPageDate(date) {
  return `${pad(date.getMonth() + 1)}.${pad(date.getDate())}.${date.getFullYear()}`;
}

function parsePageDate(value) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value.trim());
  if (!match) return null;

  return parseYmd(`${match[3]}-${match[1]}-${match[2]}`);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function addDays(date, days) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  copy.setDate(copy.getDate() + days);
  return copy;
}

function diffDays(later, earlier) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const a = new Date(later.getFullYear(), later.getMonth(), later.getDate());
  const b = new Date(earlier.getFullYear(), earlier.getMonth(), earlier.getDate());
  return Math.round((a.getTime() - b.getTime()) / msPerDay);
}

function listLocalDates(outDir) {
  if (!fs.existsSync(outDir)) return [];

  return fs.readdirSync(outDir)
    .map(name => {
      const match = /^(\d{4}-\d{2}-\d{2})_power\.xls$/i.exec(name);
      if (!match) return null;
      return match[1];
    })
    .filter(Boolean)
    .sort();
}

function buildTargetDates({ mode, explicitDate, sinceDate, latestRemoteDate, localDates, refreshDays }) {
  if (mode === 'date') {
    return [formatYmd(explicitDate)];
  }

  if (mode === 'since') {
    const dates = [];
    for (let cursor = new Date(sinceDate); cursor <= latestRemoteDate; cursor = addDays(cursor, 1)) {
      dates.push(formatYmd(cursor));
    }
    return dates;
  }

  const refreshStart = addDays(latestRemoteDate, -(refreshDays - 1));
  const latestLocalDate = localDates.length > 0 ? parseYmd(localDates[localDates.length - 1]) : null;

  let startDate = refreshStart;
  if (latestLocalDate) {
    const nextMissingDate = addDays(latestLocalDate, 1);
    startDate = nextMissingDate < refreshStart ? nextMissingDate : refreshStart;
  }

  const dates = [];
  for (let cursor = new Date(startDate); cursor <= latestRemoteDate; cursor = addDays(cursor, 1)) {
    dates.push(formatYmd(cursor));
  }
  return dates;
}

function parsePowerWorkbook(xlsPath) {
  const workbook = XLSX.readFile(xlsPath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
  const headerIndex = rows.findIndex(
    row => Array.isArray(row) && row[0] === 'Time' && row.includes('PV(W)')
  );

  if (headerIndex === -1) {
    throw new Error(`could not find power header row in ${xlsPath}`);
  }

  const headers = rows[headerIndex].map(value => (value == null ? '' : String(value).trim()));
  const timeIndex = headers.indexOf('Time');
  const pvIndex = headers.indexOf('PV(W)');
  const socIndex = headers.indexOf('SOC(%)');
  const batteryIndex = headers.indexOf('Battery(W)');
  const gridIndex = headers.indexOf('Grid (W)');
  const loadIndex = headers.indexOf('Load(W)');

  if (timeIndex === -1 || pvIndex === -1) {
    throw new Error(`missing required columns in ${xlsPath}`);
  }

  const plantName = rows[1] && rows[1][1] ? String(rows[1][1]) : 'Plant Power';
  const series = [];

  for (const row of rows.slice(headerIndex + 1)) {
    if (!Array.isArray(row) || !row[timeIndex]) continue;

    const fullTime = String(row[timeIndex]).trim();
    const timeLabel = fullTime.includes(' ') ? fullTime.split(' ')[1].slice(0, 5) : fullTime;
    const getNumber = index => {
      if (index === -1 || row[index] == null || row[index] === '') return null;
      const value = Number(row[index]);
      return Number.isFinite(value) ? value : null;
    };

    series.push({
      fullTime,
      timeLabel,
      pv: getNumber(pvIndex),
      soc: getNumber(socIndex),
      battery: getNumber(batteryIndex),
      grid: getNumber(gridIndex),
      load: getNumber(loadIndex)
    });
  }

  return { plantName, series };
}

function buildChartHtml({ ymd, plantName, series }) {
  const labels = series.map(point => point.timeLabel);
  const fullTimes = series.map(point => point.fullTime);
  const pvData = series.map(point => point.pv);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Solar Panel ${escapeHtml(ymd)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7fb;
      --panel: #ffffff;
      --text: #0f172a;
      --muted: #64748b;
      --grid: rgba(148, 163, 184, 0.18);
      --border: #dbe3ef;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .wrap {
      max-width: 1400px;
      margin: 0 auto;
      padding: 24px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px 20px 12px;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
    }
    .header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 14px;
    }
    .title {
      font-size: 28px;
      line-height: 1.15;
      font-weight: 700;
      margin: 0;
    }
    .meta {
      color: var(--muted);
      font-size: 14px;
      line-height: 1.4;
      text-align: right;
    }
    .chart-box {
      position: relative;
      height: min(68vh, 680px);
      min-height: 380px;
    }
    canvas {
      width: 100% !important;
      height: 100% !important;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="panel">
      <div class="header">
        <div>
          <h1 class="title">Solar Panel</h1>
          <div class="meta">${escapeHtml(ymd)} PV</div>
        </div>
        <div class="meta">Hover to inspect values</div>
      </div>
      <div class="chart-box">
        <canvas id="powerChart"></canvas>
      </div>
    </div>
  </div>
  <script>${CHART_JS_SOURCE}</script>
  <script>
    const labels = ${JSON.stringify(labels)};
    const fullTimes = ${JSON.stringify(fullTimes)};
    const datasets = [{
      label: 'PV',
      data: ${JSON.stringify(pvData)},
      borderColor: '#10b7d8',
      backgroundColor: 'rgba(16, 183, 216, 0.16)',
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHitRadius: 16,
      tension: 0.15,
      yAxisID: 'y'
    }];

    const chart = new Chart(document.getElementById('powerChart'), {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false
        },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: {
              usePointStyle: true,
              boxWidth: 10,
              boxHeight: 10,
              padding: 18,
              color: '#1f2937'
            }
          },
          tooltip: {
            callbacks: {
              title(items) {
                return items.length ? fullTimes[items[0].dataIndex] : '';
              },
              label(context) {
                const label = context.dataset.label || '';
                const value = context.raw == null ? '-' : context.raw;
                return label + ': ' + value + ' W';
              }
            }
          }
        },
        scales: {
          x: {
            grid: { color: '${'rgba(148, 163, 184, 0.12)'}' },
            ticks: {
              color: '#475569',
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 14
            }
          },
          y: {
            position: 'left',
            title: {
              display: true,
              text: 'Watts',
              color: '#475569'
            },
            grid: { color: '${'rgba(148, 163, 184, 0.18)'}' },
            ticks: { color: '#475569' }
          }
        }
      }
    });
  </script>
</body>
</html>`;
}

function generateChartFromXls(xlsPath, ymd) {
  const { plantName, series } = parsePowerWorkbook(xlsPath);
  if (series.length === 0) {
    throw new Error(`no data rows found in ${xlsPath}`);
  }

  const html = buildChartHtml({ ymd, plantName, series });
  const htmlPath = xlsPath.replace(/_power\.xls$/i, '_solarpanel.html');
  fs.writeFileSync(htmlPath, html, 'utf8');
  return htmlPath;
}

async function login(page, username, password) {
  console.log('Login...');
  await page.goto('https://www.semsportal.com/home/login', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  try { await page.click('#readStatement'); } catch (e) {}
  await sleep(200);
  await page.type('#username', username, { delay: 30 }).catch(() => {});
  await page.type('#password', password, { delay: 30 }).catch(() => {});
  try { await page.click('#btnLogin'); } catch (e) { await page.keyboard.press('Enter').catch(() => {}); }
  await sleep(5000);
}

async function openPowerPage(page, targetUrl) {
  console.log('Open power page...');
  await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  await page.waitForSelector('.station-date-picker_con .el-input__inner', { timeout: 30000 });
  await page.waitForSelector('.station-date-picker_left', { timeout: 30000 });
  await page.waitForSelector('.station-date-picker_right', { timeout: 30000 });
  await page.waitForSelector('.goodwe-station-charts__export', { timeout: 30000 });
  await sleep(1500);
}

async function getCurrentPageDate(page) {
  const rawValue = await page.$eval('.station-date-picker_con .el-input__inner', el => el.value);
  const parsed = parsePageDate(rawValue);
  if (!parsed) {
    throw new Error(`unable to parse page date: ${rawValue}`);
  }
  return parsed;
}

async function isRightButtonDisabled(page) {
  return await page.$eval('.station-date-picker_right', el => el.disabled);
}

async function clickDateButton(page, selector) {
  const responsePromise = page.waitForResponse(
    response => response.url().includes('/api/v2/Charts/GetPlantPowerChart') && response.request().method() === 'POST',
    { timeout: 30000 }
  );

  await page.click(selector);
  await responsePromise;
  await sleep(1500);
}

async function moveToLatestDate(page) {
  while (!(await isRightButtonDisabled(page))) {
    await clickDateButton(page, '.station-date-picker_right');
  }

  return await getCurrentPageDate(page);
}

async function moveToTargetDate(page, latestDate, targetDate) {
  const offset = diffDays(latestDate, targetDate);
  if (offset < 0) {
    throw new Error(`target date ${formatYmd(targetDate)} is newer than remote latest ${formatYmd(latestDate)}`);
  }

  let current = await getCurrentPageDate(page);
  const currentOffset = diffDays(latestDate, current);
  const remaining = offset - currentOffset;

  if (remaining < 0) {
    throw new Error(`current page date ${formatYmd(current)} is already older than target ${formatYmd(targetDate)}`);
  }

  for (let i = 0; i < remaining; i += 1) {
    await clickDateButton(page, '.station-date-picker_left');
  }

  current = await getCurrentPageDate(page);
  if (formatYmd(current) !== formatYmd(targetDate)) {
    throw new Error(`failed to reach target date ${formatYmd(targetDate)}; current page date is ${formatYmd(current)}`);
  }

  return current;
}

async function exportCurrentDate(page, outDir, ymd) {
  const requestBodies = {};
  const onRequest = req => {
    const url = req.url();
    if (/ExportPowerstationPac|GetStationPowerDataFilePath/.test(url) && req.method() === 'POST') {
      requestBodies[url] = req.postData ? req.postData() : '';
    }
  };
  page.on('request', onRequest);

  try {
    const exportResponsePromise = page.waitForResponse(
      response => response.url().includes('/api/v1/PowerStation/ExportPowerstationPac') && response.request().method() === 'POST',
      { timeout: 30000 }
    );
    const fileResponsePromise = page.waitForResponse(
      response => response.url().includes('/api/v1/ReportData/GetStationPowerDataFilePath') && response.request().method() === 'POST',
      { timeout: 30000 }
    );

    console.log(`[${ymd}] Trigger export...`);
    const clicked = await page.evaluate(() => {
      const exportButton = document.querySelector('.goodwe-station-charts__export');
      if (!exportButton) return false;
      exportButton.click();
      return true;
    });

    if (!clicked) {
      throw new Error('export button not found');
    }

    const exportResponse = await exportResponsePromise;
    const fileResponse = await fileResponsePromise;

    const exportJson = JSON.parse(await exportResponse.text());
    const fileJson = JSON.parse(await fileResponse.text());

    console.log(`[${ymd}] Export request body:`, requestBodies['https://us.semsportal.com/api/v1/PowerStation/ExportPowerstationPac'] || '');
    console.log(`[${ymd}] Export response:`, JSON.stringify(exportJson));
    console.log(`[${ymd}] File request body:`, requestBodies['https://us.semsportal.com/api/v1/ReportData/GetStationPowerDataFilePath'] || '');
    console.log(`[${ymd}] File response:`, JSON.stringify(fileJson));

    const fileUrl = fileJson && fileJson.data && fileJson.data.file_path;
    if (!fileUrl) {
      throw new Error('file_path not found in export response');
    }

    console.log(`[${ymd}] Downloading ${fileUrl}`);
    const resp = await fetch(fileUrl);
    if (!resp.ok) {
      throw new Error(`download failed with status ${resp.status}`);
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    const outPath = path.join(outDir, `${ymd}_power.xls`);
    fs.writeFileSync(outPath, buffer);
    console.log(`[${ymd}] Saved exported file to ${outPath}`);
    const htmlPath = generateChartFromXls(outPath, ymd);
    console.log(`[${ymd}] Generated chart at ${htmlPath}`);
    return outPath;
  } finally {
    page.off('request', onRequest);
  }
}

(async () => {
  const { positional, options } = parseCli(process.argv.slice(2));
  const username = process.env.GOODWE_USERNAME || positional[0] || DEFAULT_USERNAME;
  const password = process.env.GOODWE_PASSWORD || positional[1] || DEFAULT_PASSWORD;
  const stationId = process.env.STATION_ID || positional[2] || DEFAULT_STATION_ID;
  const mode = options.date ? 'date' : (options.since ? 'since' : 'update');
  const refreshDays = Number(options['refresh-days'] || DEFAULT_REFRESH_DAYS);

  const explicitDate = options.date ? parseYmd(options.date) : null;
  const sinceDate = options.since ? parseYmd(options.since) : null;

  if (options.date && !explicitDate) {
    throw new Error(`invalid --date value: ${options.date}`);
  }
  if (options.since && !sinceDate) {
    throw new Error(`invalid --since value: ${options.since}`);
  }
  if (!Number.isInteger(refreshDays) || refreshDays < 1) {
    throw new Error(`invalid --refresh-days value: ${options['refresh-days']}`);
  }

  const outDir = path.resolve(__dirname, '..', 'goodwe-exports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

  const targetUrl = `https://www.semsportal.com/powerstation/PowerStatusSnMin/${stationId}`;
  const localDates = listLocalDates(outDir);

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');

  try {
    await login(page, username, password);
    await openPowerPage(page, targetUrl);

    const latestRemoteDate = await moveToLatestDate(page);
    console.log('Remote latest date:', formatYmd(latestRemoteDate));

    if (mode === 'date' && explicitDate > latestRemoteDate) {
      throw new Error(`requested date ${formatYmd(explicitDate)} is newer than remote latest ${formatYmd(latestRemoteDate)}`);
    }
    if (mode === 'since' && sinceDate > latestRemoteDate) {
      console.log('Nothing to download: requested start date is newer than remote latest date.');
      return;
    }

    const targetDates = buildTargetDates({
      mode,
      explicitDate,
      sinceDate,
      latestRemoteDate,
      localDates,
      refreshDays
    }).sort().reverse();

    if (targetDates.length === 0) {
      console.log('Nothing to download.');
      return;
    }

    console.log('Target dates:', targetDates.join(', '));

    for (const ymd of targetDates) {
      const targetDate = parseYmd(ymd);
      await moveToTargetDate(page, latestRemoteDate, targetDate);
      const pageDate = await getCurrentPageDate(page);
      console.log(`[${ymd}] Page date is ${formatYmd(pageDate)} (${formatPageDate(pageDate)})`);
      await exportCurrentDate(page, outDir, ymd);
    }

    console.log('Done');
  } finally {
    await browser.close();
  }
})();
