import https from 'node:https';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

function parseTarget(input) {
  const defaultPort = Number.parseInt(process.env.PORT || '5173', 10);
  const raw = (input || '').trim();
  if (!raw) {
    return { host: '127.0.0.1', port: defaultPort, displayHost: '127.0.0.1' };
  }
  let urlStr = raw;
  if (!urlStr.includes('://')) {
    urlStr = `https://${urlStr}`;
  }
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname;
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : defaultPort;
    return { host, port, displayHost: host };
  } catch {
    return { host: raw, port: defaultPort, displayHost: raw };
  }
}

const cliArg = process.argv.slice(2).find(arg => !arg.startsWith('-'));
const targetInput = cliArg || process.env.LIVE_TRANSLATE_HOST || '127.0.0.1';
const { host, port: defaultDashboardPort, displayHost } = parseTarget(targetInput);
const defaultObsPort = Number.parseInt(process.env.OBS_PORT || '5174', 10);

const startedAt = Date.now();
const state = {
  online: false,
  error: 'Waiting for the host server.',
  isLegacy: false,
  version: pkg.version,
  commit: '',
  translationActive: false,
  geminiConnections: 0,
  apiKeyConfigured: false,
  network: null,
  relay: { clients: 0, audioSenders: 0, audioStreaming: false },
  setup: {
    targetLanguage1: '',
    targetLanguage2: 'none',
    targetLanguageName1: 'Language 1',
    targetLanguageName2: '',
    isDual: false,
    subtitlePacing: 'smooth',
    obsLanguage: 'both'
  },
  previews: { lang1: '', lang2: '' },
  selectedAddress: 0,
  copiedAt: 0,
  showHelp: false,
  update: null,
  updateError: '',
  checkingUpdate: false,
  refreshedAt: 0
};

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      host,
      port: defaultDashboardPort,
      path: pathname,
      rejectUnauthorized: false,
      timeout: 2500,
      headers: { Accept: 'application/json' }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`${pathname} returned ${res.statusCode}`);
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

async function refresh() {
  try {
    const activity = await getJson('/api/activity');
    state.online = true;
    state.error = '';
    state.isLegacy = false;
    state.version = activity.version || pkg.version;
    state.commit = (activity.commit || '').slice(0, 7);
    state.translationActive = Boolean(activity.translationActive);
    state.geminiConnections = Number.isInteger(activity.geminiConnections) ? activity.geminiConnections : 0;
    state.apiKeyConfigured = Boolean(activity.apiKeyConfigured);
    state.network = activity.network || null;
    state.relay = activity.relay || { clients: 0, audioSenders: 0, audioStreaming: false };
    state.setup = activity.setup || {
      targetLanguage1: '',
      targetLanguage2: 'none',
      targetLanguageName1: 'Language 1',
      targetLanguageName2: '',
      isDual: false,
      subtitlePacing: 'smooth',
      obsLanguage: 'both'
    };
    state.previews = activity.previews || { lang1: '', lang2: '' };
    state.refreshedAt = Date.now();
  } catch (error) {
    if (error.statusCode === 404) {
      try {
        const [instance, network, apiKey] = await Promise.all([
          getJson('/api/instance'),
          getJson('/api/network-ip'),
          getJson('/api/config/api-key')
        ]);
        state.online = true;
        state.error = '';
        state.isLegacy = true;
        state.version = instance.version || pkg.version;
        state.commit = (instance.commit || '').slice(0, 7);
        state.translationActive = Boolean(instance.translationActive);
        state.geminiConnections = instance.translationActive ? 1 : 0;
        state.apiKeyConfigured = Boolean(apiKey.configured);
        state.network = {
          ip: network.ip,
          dashboardPort: defaultDashboardPort,
          obsPort: network.obsPort
        };
        state.relay = { clients: 0, audioSenders: 0, audioStreaming: false };
        state.setup = {
          targetLanguage1: '',
          targetLanguage2: 'none',
          targetLanguageName1: 'Language 1',
          targetLanguageName2: '',
          isDual: false,
          subtitlePacing: 'smooth',
          obsLanguage: 'both'
        };
        state.previews = { lang1: '', lang2: '' };
        state.refreshedAt = Date.now();
      } catch (fallbackError) {
        state.online = false;
        state.error = fallbackError.message || 'Host is unreachable.';
        state.refreshedAt = Date.now();
      }
    } else {
      state.online = false;
      state.error = error.message || 'Host is unreachable.';
      state.refreshedAt = Date.now();
    }
  }
}

async function checkUpdates() {
  if (state.checkingUpdate) return;
  state.checkingUpdate = true;
  state.updateError = '';
  draw();
  try {
    if (displayHost !== '127.0.0.1' && displayHost !== 'localhost') {
      state.update = null;
      state.updateError = 'Updates can only be checked on the host Mac.';
      return;
    }
    state.update = await getJson('/api/update/status');
  } catch (error) {
    state.update = null;
    if (error.statusCode === 403 || (typeof error.message === 'string' && error.message.includes('403'))) {
      state.updateError = 'Updates can only be checked on the host Mac.';
    } else {
      state.updateError = error.message || 'Update check failed.';
    }
  } finally {
    state.checkingUpdate = false;
    draw();
  }
}

function copyToClipboard(text) {
  return new Promise((resolve) => {
    try {
      const proc = spawn('pbcopy');
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
      proc.stdin.write(text);
      proc.stdin.end();
    } catch {
      resolve(false);
    }
  });
}

function getAddresses() {
  let urlHost = displayHost;
  if ((urlHost === '127.0.0.1' || urlHost === 'localhost' || urlHost === '0.0.0.0') && state.network?.ip && state.network.ip !== 'localhost') {
    urlHost = state.network.ip;
  }
  const dashPort = state.network?.dashboardPort || defaultDashboardPort;
  const obsP = state.network?.obsPort || defaultObsPort;

  return [
    ['Dashboard', `https://${urlHost}:${dashPort}/`],
    ['Projector', `https://${urlHost}:${dashPort}/subtitles.html`],
    ['Microphone', `https://${urlHost}:${dashPort}/audio-sender.html?host=1`],
    ['OBS', `http://${urlHost}:${obsP}/?obs=true`]
  ];
}

const reset = '\x1b[0m';
const dim = '\x1b[2m';
const bold = '\x1b[1m';
const green = '\x1b[32m';
const red = '\x1b[31m';
const yellow = '\x1b[33m';
const cyan = '\x1b[36m';
const coral = '\x1b[38;5;209m';

function paint(text, color = '') {
  return `${color}${text}${reset}`;
}

function visibleLength(text) {
  return String(text ?? '').replace(/\x1b\[[0-9;]*m/g, '').length;
}

function clip(text, width) {
  const plain = String(text ?? '');
  if (visibleLength(plain) <= width) return plain;
  if (width <= 0) return '';
  if (width === 1) return '…';

  let visible = 0;
  let result = '';
  let inEscape = false;
  let escapeSeq = '';

  for (let i = 0; i < plain.length; i += 1) {
    const char = plain[i];
    if (char === '\x1b') {
      inEscape = true;
      escapeSeq = char;
      continue;
    }
    if (inEscape) {
      escapeSeq += char;
      if (char === 'm') {
        inEscape = false;
        result += escapeSeq;
      }
      continue;
    }
    if (visible + 1 > width - 1) {
      result += '…';
      break;
    }
    result += char;
    visible += 1;
  }
  return result + reset;
}

function pad(text, width) {
  const value = clip(text, width);
  return value + ' '.repeat(Math.max(0, width - visibleLength(value)));
}

function line(width, left, right = '') {
  const gap = Math.max(1, width - visibleLength(left) - visibleLength(right));
  return left + ' '.repeat(gap) + right;
}

function boxTop(width, title) {
  const label = title ? ` ${title} ` : '';
  const fill = Math.max(0, width - 2 - visibleLength(label));
  return `┌${label}${'─'.repeat(fill)}┐`;
}

function boxMid(width) {
  return `├${'─'.repeat(Math.max(0, width - 2))}┤`;
}

function boxBot(width) {
  return `└${'─'.repeat(Math.max(0, width - 2))}┘`;
}

function boxRow(width, text) {
  return `│${pad(text, width - 2)}│`;
}

function clock() {
  return new Date().toLocaleTimeString();
}

function uptime() {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function wrapText(text, width) {
  if (!text || typeof text !== 'string') return [];
  const clean = text.trim();
  if (!clean) return [];
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    if (!currentLine) {
      if (word.length > width) {
        let rem = word;
        while (rem.length > width) {
          lines.push(rem.slice(0, width));
          rem = rem.slice(width);
        }
        currentLine = rem;
      } else {
        currentLine = word;
      }
    } else if (currentLine.length + 1 + word.length <= width) {
      currentLine += ` ${word}`;
    } else {
      lines.push(currentLine);
      if (word.length > width) {
        let rem = word;
        while (rem.length > width) {
          lines.push(rem.slice(0, width));
          rem = rem.slice(width);
        }
        currentLine = rem;
      } else {
        currentLine = word;
      }
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

function draw() {
  const columns = Math.max(72, process.stdout.columns || 100);
  const rowsCount = Math.max(24, process.stdout.rows || 30);
  const width = Math.min(columns, 120);

  const dashPort = state.network?.dashboardPort || defaultDashboardPort;
  const obsP = state.network?.obsPort || defaultObsPort;

  const hostState = state.online ? paint('up', green) : paint('down', red);
  let geminiState = paint('idle', yellow);
  if (state.geminiConnections > 0) {
    geminiState = paint(`${state.geminiConnections} active`, green);
  } else if (state.translationActive) {
    geminiState = paint('active', green);
  }
  const audioState = state.relay?.audioStreaming ? paint('streaming', green) : paint('idle', yellow);
  const keyState = state.apiKeyConfigured ? paint('saved', green) : paint('missing', red);

  const rows = [];
  const title = `${bold}${coral}Live Translate${reset} ${bold}Activity${reset}  ${dim}host:${reset} ${cyan}${displayHost}${reset}`;
  const meta = `${dim}v${state.version}${reset}  ${clock()}`;
  rows.push(boxTop(width, ''));
  rows.push(boxRow(width, line(width - 2, ` ${title}`, meta)));
  rows.push(boxMid(width));

  const statWidth = Math.floor((width - 2) / 4);
  const stats = [
    ` Host    ${hostState}`,
    ` Gemini  ${geminiState}`,
    ` Audio   ${audioState}`,
    ` Key     ${keyState}`
  ].map((item) => pad(item, statWidth)).join('');
  rows.push(boxRow(width, stats));
  rows.push(boxMid(width));

  const left = Math.max(36, Math.floor((width - 1) * 0.45));
  const right = width - 1 - left;
  const services = [
    ['dashboard', `https :${dashPort}`, state.online ? paint('listening', green) : paint('unreachable', red)],
    ['obs', `http  :${obsP}`, (state.online && state.network?.obsPort) ? paint('listed', green) : (state.online ? paint('ready', dim) : paint('down', red))],
    ['gemini', 'browser proxy', state.geminiConnections > 0 ? paint(`${state.geminiConnections} active`, green) : (state.translationActive ? paint('active', green) : paint('idle', dim))],
    ['relay', 'local sockets', state.relay?.audioStreaming ? paint('streaming', green) : (state.online ? paint(`${state.relay?.clients || 0} clients`, cyan) : paint('down', red))]
  ];
  const addresses = getAddresses();

  rows.push(`├${'─'.repeat(left - 1)}┬${'─'.repeat(right - 1)}┤`);
  rows.push(`│${pad(` ${bold}Services${reset}`, left - 1)}│${pad(` ${bold}Addresses${reset} ${dim}(1-4 jump, j/k select, c copy)${reset}`, right - 1)}│`);
  for (let i = 0; i < 4; i += 1) {
    const [name, detail, status] = services[i];
    const leftText = line(left - 2, ` ${pad(name, 10)} ${detail}`, status);
    const [label, url] = addresses[i];
    const isSelected = i === state.selectedAddress;
    const prefix = isSelected ? `${cyan}▶${reset} ` : '  ';
    const tag = `[${i + 1}]`;
    const labelFormatted = isSelected ? `${bold}${cyan}${tag} ${pad(label, 11)}${reset}` : `${dim}${tag}${reset} ${pad(label, 11)}`;
    const urlClipped = clip(url, right - 22);
    const rightText = `${prefix}${labelFormatted} ${dim}${urlClipped}${reset}`;
    rows.push(`│${pad(leftText, left - 1)}│${pad(rightText, right - 1)}│`);
  }
  rows.push(`├${'─'.repeat(left - 1)}┴${'─'.repeat(right - 1)}┤`);

  const selectedAddr = addresses[state.selectedAddress] || addresses[0];
  const [selLabel, selUrl] = selectedAddr;
  const isCopied = state.copiedAt && (Date.now() - state.copiedAt < 2000);
  const badge = isCopied ? `  ${bold}${green}✔ Copied!${reset}` : '';
  const hint = `  ${dim}(press c to copy, 1-4 jump)${reset}`;
  const fullLabel = ` ${bold}Selected [${state.selectedAddress + 1}] ${selLabel}:${reset} ${cyan}${selUrl}${reset}`;

  let detailText = `${fullLabel}${badge || hint}`;
  if (visibleLength(detailText) > width - 2) {
    detailText = `${fullLabel}${badge}`;
  }
  if (visibleLength(detailText) > width - 2) {
    detailText = ` ${bold}[${state.selectedAddress + 1}]${reset} ${cyan}${selUrl}${reset}${badge}`;
  }
  rows.push(boxRow(width, detailText));

  // Caption panels
  const innerWidth = width - 2;
  const leftColWidth = Math.floor((innerWidth - 1) / 2);
  const rightColWidth = innerWidth - 1 - leftColWidth;

  const lang1Name = state.setup.targetLanguageName1 || (state.setup.targetLanguage1 ? state.setup.targetLanguage1.toUpperCase() : 'Language 1');
  let lang2Name = 'Language 2';
  if (state.setup.isDual) {
    lang2Name = state.setup.targetLanguageName2 || (state.setup.targetLanguage2 ? state.setup.targetLanguage2.toUpperCase() : 'Language 2');
  } else if (state.setup.targetLanguageName2) {
    lang2Name = `${state.setup.targetLanguageName2} (disabled)`;
  } else {
    lang2Name = 'Secondary (disabled)';
  }

  const leftDashesCount = Math.max(0, leftColWidth - 4 - visibleLength(lang1Name));
  const leftBorder = `─ ${bold}${cyan}${lang1Name}${reset} ─${'─'.repeat(leftDashesCount)}`;
  const rightDashesCount = Math.max(0, rightColWidth - 4 - visibleLength(lang2Name));
  const rightBorder = `─ ${bold}${cyan}${lang2Name}${reset} ─${'─'.repeat(rightDashesCount)}`;
  rows.push(`├${leftBorder}┬${rightBorder}┤`);

  const raw1 = state.previews?.lang1 || '';
  const wrapped1 = wrapText(raw1, leftColWidth - 2);
  const raw2 = state.previews?.lang2 || '';
  const wrapped2 = wrapText(raw2, rightColWidth - 2);

  const captionRows = Math.max(3, Math.min(6, Math.floor((rowsCount - 22) / 2)));
  let visible1 = [];
  if (wrapped1.length === 0) {
    visible1 = [paint('Waiting for captions', dim)];
  } else if (wrapped1.length > captionRows) {
    visible1 = wrapped1.slice(-captionRows);
  } else {
    visible1 = wrapped1;
  }

  let visible2 = [];
  if (wrapped2.length === 0) {
    visible2 = [paint('Waiting for captions', dim)];
  } else if (wrapped2.length > captionRows) {
    visible2 = wrapped2.slice(-captionRows);
  } else {
    visible2 = wrapped2;
  }

  for (let r = 0; r < captionRows; r += 1) {
    const t1 = visible1[r] || '';
    const t2 = visible2[r] || '';
    const leftText = ` ${pad(t1, leftColWidth - 2)} `;
    const rightText = ` ${pad(t2, rightColWidth - 2)} `;
    rows.push(`│${leftText}│${rightText}│`);
  }
  rows.push(`├${'─'.repeat(leftColWidth)}┴${'─'.repeat(rightColWidth)}┤`);

  if (state.showHelp) {
    rows.push(boxRow(width, ` ${bold}${yellow}Help & Shortcuts${reset}`));
    rows.push(boxRow(width, `   ${bold}q${reset} or ${bold}Ctrl-C${reset}   Quit Activity and restore terminal cursor`));
    rows.push(boxRow(width, `   ${bold}r${reset}            Refresh status immediately`));
    rows.push(boxRow(width, `   ${bold}j / k / ↑ / ↓${reset}  Move address selection`));
    rows.push(boxRow(width, `   ${bold}1 - 4${reset}        Jump selection: 1 Dashboard, 2 Projector, 3 Mic, 4 OBS`));
    rows.push(boxRow(width, `   ${bold}c${reset}            Copy selected URL using pbcopy`));
    rows.push(boxRow(width, `   ${bold}u${reset}            Check GitHub update status (host Mac only)`));
    rows.push(boxRow(width, `   ${bold}?${reset}            Toggle this help panel`));
    rows.push(boxMid(width));
  }

  const commit = state.commit ? state.commit.slice(0, 7) : '—';
  let updateLine = 'press u to check GitHub';
  if (state.checkingUpdate) updateLine = paint('checking origin/main…', yellow);
  else if (state.updateError) updateLine = paint(state.updateError, red);
  else if (state.update?.updateAvailable) updateLine = paint(`update ${state.update.remoteCommit} is on GitHub`, yellow);
  else if (state.update?.diverged) updateLine = paint('local main has diverged from GitHub', yellow);
  else if (state.update) updateLine = paint('this Mac matches GitHub', green);

  const pacing = state.setup.subtitlePacing || 'smooth';
  const obsChoice = state.setup.obsLanguage || 'both';
  rows.push(boxRow(width, ` ${bold}Session${reset}   commit ${commit}   pacing: ${pacing}   obs: ${obsChoice}   view: ${paint(uptime(), cyan)}`));
  rows.push(boxRow(width, ` ${pad('updates', 10)}${updateLine}`));
  if (!state.online) {
    rows.push(boxRow(width, ` ${paint(state.error, red)}`));
    rows.push(boxRow(width, ` ${dim}Start LiveTranslation or check connection at https://${displayHost}:${dashPort}/${reset}`));
  }

  rows.push(boxMid(width));
  rows.push(boxRow(width, ` ${bold}q${reset} quit   ${bold}r${reset} refresh   ${bold}?${reset} help   ${bold}j/k${reset} select   ${bold}1-4${reset} jump   ${bold}c${reset} copy URL   ${bold}u${reset} updates`));
  rows.push(boxBot(width));

  process.stdout.write('\x1b[H\x1b[2J');
  process.stdout.write(`${rows.join('\n')}\n`);
}

function cleanup() {
  process.stdout.write('\x1b[0m\x1b[?25h');
}

let timer = null;

function shutdown() {
  if (timer) clearInterval(timer);
  cleanup();
  if (process.stdin.isTTY && process.stdin.setRawMode) {
    try {
      process.stdin.setRawMode(false);
    } catch {}
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
process.on('exit', cleanup);

await refresh();
draw();

if (!process.stdin.isTTY) {
  process.exit(state.online ? 0 : 1);
}

process.stdout.write('\x1b[?25l');
if (process.stdin.isTTY && process.stdin.setRawMode) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdout.on('resize', draw);

timer = setInterval(async () => {
  await refresh();
  draw();
}, 1000);

process.stdin.on('data', async (data) => {
  const key = data.toString();
  if (key === 'q' || key === '\u0003') {
    shutdown();
    return;
  }
  if (key === '?') {
    state.showHelp = !state.showHelp;
    draw();
    return;
  }
  if (key === 'r' || key === 'R') {
    await refresh();
    draw();
    return;
  }
  if (key === 'j' || key === '\x1b[B' || key === '\x1b[C') {
    state.selectedAddress = (state.selectedAddress + 1) % 4;
    draw();
    return;
  }
  if (key === 'k' || key === '\x1b[A' || key === '\x1b[D') {
    state.selectedAddress = (state.selectedAddress + 3) % 4;
    draw();
    return;
  }
  if (key >= '1' && key <= '4') {
    state.selectedAddress = Number.parseInt(key, 10) - 1;
    draw();
    return;
  }
  if (key === 'c' || key === 'C') {
    const urls = getAddresses();
    const selected = urls[state.selectedAddress]?.[1] || '';
    if (selected) {
      await copyToClipboard(selected);
      state.copiedAt = Date.now();
      draw();
      setTimeout(() => {
        if (Date.now() - state.copiedAt >= 1900) {
          state.copiedAt = 0;
          draw();
        }
      }, 2000);
    }
    return;
  }
  if (key === 'u' || key === 'U') {
    await checkUpdates();
    return;
  }
});
