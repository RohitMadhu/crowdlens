import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';

const WebSocketClient = globalThis.WebSocket;

if (!WebSocketClient) {
  throw new Error('This script requires Node.js 22.4+ for the built-in WebSocket client.');
}

const BUSY_PATTERNS = [
  /Popular times/gi,
  /(?:Less|More|Busier|As)\s+busy\s+than\s+usual/gi,
  /Usually\s+(?:not\s+too\s+busy|a\s+little\s+busy|as\s+busy|very\s+busy)/gi,
  /Currently\s+\d+%?\s+busy/gi,
  /Wait time:?[\sA-Za-z0-9]+/gi,
];

const EXPECTED_TIME_SLOTS = [
  { hour24: 6, label: '6 AM' },
  { hour24: 7, label: '7 AM' },
  { hour24: 8, label: '8 AM' },
  { hour24: 9, label: '9 AM' },
  { hour24: 10, label: '10 AM' },
  { hour24: 11, label: '11 AM' },
  { hour24: 12, label: '12 PM' },
  { hour24: 13, label: '1 PM' },
  { hour24: 14, label: '2 PM' },
  { hour24: 15, label: '3 PM' },
  { hour24: 16, label: '4 PM' },
  { hour24: 17, label: '5 PM' },
  { hour24: 18, label: '6 PM' },
  { hour24: 19, label: '7 PM' },
  { hour24: 20, label: '8 PM' },
  { hour24: 21, label: '9 PM' },
  { hour24: 22, label: '10 PM' },
  { hour24: 23, label: '11 PM' },
];

const WEEKDAY_NAMES_SUNDAY_FIRST = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const DEFAULT_TIMEOUT_MS = 30000;

function buildMapsUrl(query) {
  return `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`;
}

function buildSearchUrl(query) {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`;
}

function buildCrashHint(errorText) {
  if (!/Target crashed/i.test(errorText)) {
    return null;
  }

  return {
    likelyCause:
      'The Chromium renderer crashed, usually because the page was pushed too hard by low-memory flags.',
    firstFlagsToRelax: [
      '--js-flags=--max-old-space-size=64',
      '--disable-gpu',
      '--skia-font-cache-limit-mb=8',
      '--skia-resource-cache-limit-mb=32',
    ],
    nextSteps: [
      'Relaunch Obscura with a higher old-space limit like 128.',
      'Remove --disable-gpu if the crash persists.',
      'Remove the Skia cache limit flags if needed.',
      'If the page still crashes, try --inspect-current-page after manually opening the place in your CDP browser.',
    ],
  };
}

function parseArgs(argv) {
  const args = {
    mode: 'maps',
    settleMs: 1000,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    includeDumps: false,
    inspectCurrentPage: false,
    keepExtraTabs: false,
    limitedViewRetries: 1,
    postDetachResample: true,
    popularTimesWaitMs: 15000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--query') {
      args.query = argv[++index];
    } else if (arg === '--url') {
      args.url = argv[++index];
    } else if (arg === '--mode') {
      args.mode = argv[++index];
    } else if (arg === '--settle-ms') {
      args.settleMs = Number(argv[++index]);
    } else if (arg === '--timeout-ms') {
      args.timeoutMs = Number(argv[++index]);
    } else if (arg === '--cdp-url') {
      args.cdpUrl = argv[++index];
    } else if (arg === '--include-dumps') {
      args.includeDumps = true;
    } else if (arg === '--inspect-current-page') {
      args.inspectCurrentPage = true;
    } else if (arg === '--keep-extra-tabs') {
      args.keepExtraTabs = true;
    } else if (arg === '--limited-view-retries') {
      args.limitedViewRetries = Number(argv[++index]);
    } else if (arg === '--no-post-detach-resample') {
      args.postDetachResample = false;
    } else if (arg === '--popular-times-wait-ms') {
      args.popularTimesWaitMs = Number(argv[++index]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.cdpUrl) {
    throw new Error('Provide --cdp-url pointing at a browser CDP endpoint');
  }

  if (!args.inspectCurrentPage && !args.url && !args.query) {
    throw new Error('Provide either --url or --query');
  }

  return args;
}

function normalizeText(value) {
  return value.replace(/\u202f/g, ' ').replace(/\xa0/g, ' ').replace(/\s+/g, ' ').trim();
}

function findFirstPrefixMatch(values, prefix) {
  const needle = `${prefix}:`;
  for (const value of values) {
    if (value.startsWith(needle)) {
      return value.slice(needle.length).trim();
    }
  }
  return null;
}

function findBusyPhrases(...sources) {
  const found = [];
  const seen = new Set();

  for (const source of sources) {
    for (const pattern of BUSY_PATTERNS) {
      const matches = source.match(pattern) || [];
      for (const match of matches) {
        const phrase = normalizeText(match);
        const dedupeKey = phrase.toLowerCase();
        if (phrase && !seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          found.push(phrase);
        }
      }
    }
  }

  return found;
}

function classifySnapshot(snapshot) {
  const combined = `${snapshot.visibleText}\n${snapshot.ariaLabels.join('\n')}`;
  if (combined.includes('About this page') && combined.includes('unusual traffic')) {
    return 'captcha';
  }
  if (combined.includes("You're seeing a limited view of Google Maps.")) {
    return 'limited_view';
  }
  if (snapshot.busyPhrases.length > 0 || snapshot.busyAriaLabels.length > 0) {
    return 'busy_text_visible';
  }
  if (combined.trim()) {
    return 'content_without_busy_text';
  }
  return 'empty';
}

function hasPopularTimesSignal(snapshot) {
  return (
    (snapshot.busyAriaLabels || []).some((value) => /% busy at|Popular times|Currently \d+% busy/i.test(value)) ||
    (snapshot.busyPhrases || []).some((value) => /Popular times|Currently \d+% busy|Usually/i.test(value)) ||
    (snapshot.popularTimes || []).some((day) => (day.hours || []).some((hour) => typeof hour.percentage === 'number')) ||
    typeof snapshot.currentPopularity === 'number'
  );
}

function summarizeHours(visibleText) {
  const normalized = visibleText.replace(/\u202f/g, ' ');
  const match = normalized.match(/\b(Open|Closed)\s*·\s*([^\n]+)/i);
  if (!match) {
    return {};
  }
  return {
    status: match[1],
    detail: normalizeText(match[2]),
    raw: normalizeText(match[0]),
  };
}

function parseHourLabel(label) {
  const match = label.match(/^(\d{1,2})\s*(AM|PM)$/i);
  if (!match) {
    return null;
  }

  const hour = Number(match[1]) % 12;
  const meridiem = match[2].toUpperCase();
  return {
    label: `${Number(match[1])} ${meridiem}`,
    hour24: meridiem === 'PM' ? hour + 12 : hour,
  };
}

function parseBusySequenceEntry(label) {
  const normalized = normalizeText(label).replace(/\.$/, '');
  const explicitMatch = normalized.match(/^(\d+)% busy at (\d{1,2}\s*(?:AM|PM))$/i);
  if (explicitMatch) {
    const time = parseHourLabel(explicitMatch[2]);
    if (!time) {
      return null;
    }
    return {
      type: 'hour',
      percentage: Number(explicitMatch[1]),
      time,
    };
  }

  const currentMatch = normalized.match(/^Currently (\d+)% busy, usually (\d+)% busy$/i);
  if (currentMatch) {
    return {
      type: 'current',
      currentPercentage: Number(currentMatch[1]),
      usualPercentage: Number(currentMatch[2]),
    };
  }

  return null;
}

export function parsePopularTimesFromAriaLabels(ariaLabels) {
  const entries = ariaLabels.map(parseBusySequenceEntry).filter(Boolean);

  if (entries.length === 0) {
    return {
      currentPopularity: null,
      currentUsualPopularity: null,
      currentPopularityDay: null,
      currentPopularityTime: null,
      popularTimes: [],
    };
  }

  const days = [];
  let dayEntries = [];
  let currentPopularity = null;
  let currentUsualPopularity = null;
  let currentPopularityDay = null;
  let currentPopularityTime = null;

  for (const entry of entries) {
    dayEntries.push(entry);
    if (dayEntries.length !== EXPECTED_TIME_SLOTS.length) {
      continue;
    }

    const dayIndex = days.length;
    const dayName = WEEKDAY_NAMES_SUNDAY_FIRST[dayIndex % WEEKDAY_NAMES_SUNDAY_FIRST.length];
    const hours = dayEntries.map((item, slotIndex) => {
      const expectedSlot = EXPECTED_TIME_SLOTS[slotIndex];
      if (item.type === 'current') {
        if (currentPopularity === null) {
          currentPopularity = item.currentPercentage;
          currentUsualPopularity = item.usualPercentage;
          currentPopularityDay = dayName;
          currentPopularityTime = expectedSlot.label;
        }
        return {
          hour24: expectedSlot.hour24,
          label: expectedSlot.label,
          percentage: item.usualPercentage,
          currentPercentage: item.currentPercentage,
          isCurrent: true,
        };
      }

      return {
        hour24: item.time.hour24,
        label: item.time.label,
        percentage: item.percentage,
        isCurrent: false,
      };
    });

    days.push({
      dayIndex,
      dayName,
      hours,
    });
    dayEntries = [];
  }

  return {
    currentPopularity,
    currentUsualPopularity,
    currentPopularityDay,
    currentPopularityTime,
    popularTimes: days,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGetJson(urlString, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const client = url.protocol === 'https:' ? https : http;
    const request = client.get(
      url,
      {
        headers: {
          Accept: 'application/json',
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (response.statusCode && response.statusCode >= 400) {
            reject(new Error(`HTTP ${response.statusCode} fetching ${urlString}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`Invalid JSON from ${urlString}: ${String(error)}`));
          }
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Timed out fetching ${urlString}`));
    });
    request.on('error', reject);
  });
}

async function resolveBrowserWsUrl(cdpUrl, timeoutMs) {
  const url = new URL(cdpUrl);
  if ((url.protocol === 'ws:' || url.protocol === 'wss:') && url.pathname.includes('/devtools/browser/')) {
    return url.toString();
  }

  const versionUrl = new URL(cdpUrl);
  if (versionUrl.protocol === 'ws:') {
    versionUrl.protocol = 'http:';
  } else if (versionUrl.protocol === 'wss:') {
    versionUrl.protocol = 'https:';
  }
  versionUrl.pathname = '/json/version';
  versionUrl.search = '';
  versionUrl.hash = '';
  const versionInfo = await httpGetJson(versionUrl.toString(), timeoutMs);
  if (!versionInfo.webSocketDebuggerUrl) {
    throw new Error(`CDP endpoint ${cdpUrl} did not expose webSocketDebuggerUrl`);
  }
  return versionInfo.webSocketDebuggerUrl;
}

class CdpConnection {
  constructor(wsUrl, timeoutMs) {
    this.wsUrl = wsUrl;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocketClient(this.wsUrl);
      this.socket = socket;
      let opened = false;
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`Timed out connecting to ${this.wsUrl}`));
      }, this.timeoutMs);

      socket.addEventListener('open', () => {
        clearTimeout(timer);
        opened = true;
        resolve();
      });

      socket.addEventListener('message', (event) => {
        try {
          const raw = typeof event.data === 'string' ? event.data : String(event.data);
          this.handleMessage(raw);
        } catch (error) {
          this.failPending(error);
        }
      });

      socket.addEventListener('error', (event) => {
        clearTimeout(timer);
        const error = event.error || new Error('CDP WebSocket error');
        if (!opened) {
          reject(error);
          return;
        }
        this.failPending(error);
      });

      socket.addEventListener('close', () => {
        clearTimeout(timer);
        this.failPending(new Error('CDP connection closed'));
      });
    });
  }

  handleMessage(raw) {
    const message = JSON.parse(raw);
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`${pending.method} failed: ${message.error.message}`));
        return;
      }
      pending.resolve(message.result ?? {});
      return;
    }

    const key = `${message.sessionId || ''}:${message.method}`;
    const listeners = this.listeners.get(key);
    if (!listeners || listeners.length === 0) {
      return;
    }

    for (const listener of [...listeners]) {
      if (listener.predicate(message)) {
        this.removeListener(key, listener);
        clearTimeout(listener.timer);
        listener.resolve(message);
      }
    }
  }

  removeListener(key, listener) {
    const listeners = this.listeners.get(key);
    if (!listeners) {
      return;
    }
    const index = listeners.indexOf(listener);
    if (index >= 0) {
      listeners.splice(index, 1);
    }
    if (listeners.length === 0) {
      this.listeners.delete(key);
    }
  }

  waitForEvent(method, { sessionId = '', timeoutMs = this.timeoutMs, predicate = () => true } = {}) {
    return new Promise((resolve, reject) => {
      const key = `${sessionId}:${method}`;
      const listener = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeListener(key, listener);
          reject(new Error(`Timed out waiting for ${method}`));
        }, timeoutMs),
      };
      const listeners = this.listeners.get(key) || [];
      listeners.push(listener);
      this.listeners.set(key, listeners);
    });
  }

  send(method, params = {}, sessionId = null) {
    if (!this.socket || this.socket.readyState !== WebSocketClient.OPEN) {
      return Promise.reject(new Error('CDP socket is not open'));
    }

    const id = this.nextId++;
    const payload = {
      id,
      method,
      params,
    };
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP response to ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  failPending(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }

    for (const [key, listeners] of this.listeners.entries()) {
      for (const listener of listeners) {
        clearTimeout(listener.timer);
        listener.reject(error);
      }
      this.listeners.delete(key);
    }
  }

  async close() {
    if (!this.socket) {
      return;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket.readyState === WebSocketClient.OPEN || socket.readyState === WebSocketClient.CONNECTING) {
      socket.close();
    }
  }
}

async function evaluateInPage(cdp, sessionId, expression) {
  const result = await cdp.send(
    'Runtime.evaluate',
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
    },
    sessionId
  );

  if (result.exceptionDetails) {
    const description = result.exceptionDetails.text || result.result?.description || 'Runtime.evaluate failed';
    throw new Error(description);
  }

  return result.result?.value;
}

async function takeSnapshot(cdp, sessionId, includeDumps) {
  const snapshot = await evaluateInPage(
    cdp,
    sessionId,
    `(() => {
      const normalize = (value) => value.replace(/\\u202f/g, ' ').replace(/\\xa0/g, ' ').replace(/\\s+/g, ' ').trim();
      const ariaLabels = Array.from(document.querySelectorAll('[aria-label]'))
        .map((node) => node.getAttribute('aria-label'))
        .filter(Boolean)
        .map(normalize);
      const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
        .map((node) => normalize(node.textContent || ''))
        .filter(Boolean);
      const placeLinks = Array.from(
        document.querySelectorAll("a[href*='/maps/place/'], a[href*='/maps/preview/place/']")
      )
        .map((node) => node.href)
        .filter(Boolean);

      return {
        location: window.location.href,
        title: document.querySelector('h1')?.textContent?.trim() || null,
        headings,
        ariaLabels,
        visibleText: document.body?.innerText || '',
        placeLinks,
        html: document.documentElement?.outerHTML || '',
      };
    })()`
  );

  const visibleText = normalizeText(snapshot.visibleText || '');
  const ariaLabels = (snapshot.ariaLabels || []).map(normalizeText);
  const headings = (snapshot.headings || []).map(normalizeText);
  const busyAriaLabels = ariaLabels.filter((value) => /(busy|Popular times|usually|Wait time)/i.test(value));
  const busyPhrases = findBusyPhrases(visibleText, ariaLabels.join('\n'));
  const combinedValues = [...ariaLabels, ...headings, visibleText];
  const popularTimes = parsePopularTimesFromAriaLabels(busyAriaLabels);

  const result = {
    url: snapshot.location,
    title: snapshot.title || headings[0] || null,
    secondaryTitle: headings[1] || null,
    address: findFirstPrefixMatch(combinedValues, 'Address'),
    website: findFirstPrefixMatch(combinedValues, 'Website'),
    phone: findFirstPrefixMatch(combinedValues, 'Phone'),
    hours: summarizeHours(snapshot.visibleText || ''),
    limitedView: visibleText.includes("You're seeing a limited view of Google Maps."),
    busyPhrases,
    busyAriaLabels,
    currentPopularity: popularTimes.currentPopularity,
    currentUsualPopularity: popularTimes.currentUsualPopularity,
    currentPopularityDay: popularTimes.currentPopularityDay,
    currentPopularityTime: popularTimes.currentPopularityTime,
    popularTimes: popularTimes.popularTimes,
    placeLinks: snapshot.placeLinks || [],
  };

  if (includeDumps) {
    result.visibleText = snapshot.visibleText || '';
    result.ariaLabels = ariaLabels;
    result.headings = headings;
    result.html = snapshot.html || '';
  }

  result.classification = classifySnapshot({
    ...result,
    visibleText,
    ariaLabels,
    busyPhrases,
    busyAriaLabels,
  });

  return result;
}

async function navigateAndWait(cdp, sessionId, url, timeoutMs, settleMs) {
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', { sessionId, timeoutMs });
  const response = await cdp.send('Page.navigate', { url }, sessionId);
  if (response.errorText) {
    throw new Error(`Page.navigate failed: ${response.errorText}`);
  }

  let navigationError = null;
  try {
    await loadEvent;
  } catch (error) {
    navigationError = String(error);
  }
  await sleep(settleMs);
  return navigationError;
}

async function maybeFollowFirstPlaceLink(cdp, sessionId, snapshot, timeoutMs, settleMs) {
  if (snapshot.title || snapshot.placeLinks.length === 0) {
    return snapshot;
  }

  await navigateAndWait(cdp, sessionId, snapshot.placeLinks[0], timeoutMs, settleMs);
  return takeSnapshot(cdp, sessionId, false);
}

async function takeSettledSnapshot(cdp, sessionId, args, targetUrl) {
  let snapshot = await takeSnapshot(cdp, sessionId, args.includeDumps);
  if (targetUrl && !args.url) {
    snapshot = await maybeFollowFirstPlaceLink(cdp, sessionId, snapshot, args.timeoutMs, args.settleMs);
    if (args.includeDumps) {
      snapshot = await takeSnapshot(cdp, sessionId, true);
    }
  }
  return snapshot;
}

async function waitForPopularTimesSnapshot(cdp, sessionId, timeoutMs, includeDumps, initialSnapshot = null) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = initialSnapshot;

  while (Date.now() < deadline) {
    if (!snapshot) {
      snapshot = await takeSnapshot(cdp, sessionId, false);
    }
    if (hasPopularTimesSignal(snapshot)) {
      break;
    }
    if (snapshot.classification === 'captcha' || snapshot.classification === 'limited_view') {
      break;
    }
    await sleep(1000);
    snapshot = null;
  }

  if (!snapshot) {
    snapshot = await takeSnapshot(cdp, sessionId, false);
  }

  if (includeDumps) {
    const dumpSnapshot = await takeSnapshot(cdp, sessionId, true);
    return {
      ...snapshot,
      visibleText: dumpSnapshot.visibleText,
      ariaLabels: dumpSnapshot.ariaLabels,
      headings: dumpSnapshot.headings,
      html: dumpSnapshot.html,
    };
  }

  return snapshot;
}

function isWeakNavigationSnapshot(snapshot) {
  return (
    snapshot.classification === 'content_without_busy_text' &&
    !snapshot.title &&
    !snapshot.address &&
    !snapshot.website &&
    !snapshot.phone
  );
}

async function getPageTargets(cdp) {
  const { targetInfos = [] } = await cdp.send('Target.getTargets');
  return targetInfos.filter(
    (target) =>
      target.type === 'page' &&
      !target.url.startsWith('devtools://') &&
      (!target.url.startsWith('chrome://') || target.url.startsWith('chrome://newtab'))
  );
}

function chooseTarget(pageTargets, inspectCurrentPage) {
  const reversed = [...pageTargets].reverse();
  if (inspectCurrentPage) {
    return reversed.find((target) => target.url && target.url !== 'about:blank') || reversed[0] || null;
  }
  return (
    reversed.find((target) => !target.url || target.url === 'about:blank') ||
    reversed.find((target) => target.url && target.url !== 'about:blank') ||
    reversed[0] ||
    null
  );
}

async function closeExtraPageTargets(cdp, pageTargets, keepTargetId) {
  for (const target of pageTargets) {
    if (target.targetId === keepTargetId) {
      continue;
    }

    try {
      await cdp.send('Target.closeTarget', { targetId: target.targetId });
    } catch (error) {
      // Some runtimes may reject closeTarget for already-closing startup pages.
      // Keeping the scrape moving is better than failing because cleanup raced.
    }
  }
}

async function openBrowserSession(args) {
  const browserWsUrl = await resolveBrowserWsUrl(args.cdpUrl, args.timeoutMs);
  const cdp = new CdpConnection(browserWsUrl, args.timeoutMs);
  await cdp.connect();

  let pageTargets = await getPageTargets(cdp);
  let target = chooseTarget(pageTargets, args.inspectCurrentPage);

  if (!target) {
    const { targetId } = await cdp.send('Target.createTarget', {
      url: 'about:blank',
      background: false,
      newWindow: false,
    });
    pageTargets = await getPageTargets(cdp);
    target = pageTargets.find((candidate) => candidate.targetId === targetId) || {
      targetId,
      url: 'about:blank',
    };
  }

  if (!args.keepExtraTabs) {
    await closeExtraPageTargets(cdp, pageTargets, target.targetId);
  }

  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);

  return {
    cdp,
    sessionId,
    targetId: target.targetId,
    close: async () => {
      try {
        await cdp.send('Target.detachFromTarget', { sessionId });
      } catch (error) {
        // Browser shutdowns and page crashes can invalidate the session before
        // we detach. The CDP socket close below is the important cleanup step.
      } finally {
        if (!args.inspectCurrentPage) {
          try {
            await cdp.send('Target.closeTarget', { targetId: target.targetId });
          } catch (error) {
            // Some runtimes may already have closed the target. Detaching and
            // closing the CDP socket is still enough to keep the scrape moving.
          }
        }
        await cdp.close();
      }
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetUrl = args.inspectCurrentPage
    ? null
    : args.url || (args.mode === 'search' ? buildSearchUrl(args.query) : buildMapsUrl(args.query));

  let session = await openBrowserSession(args);
  let navigationError = null;

  try {
    const { cdp, sessionId } = session;

    if (targetUrl) {
      try {
        navigationError = await navigateAndWait(cdp, sessionId, targetUrl, args.timeoutMs, args.settleMs);
      } catch (error) {
        navigationError = String(error);
      }
    } else {
      await sleep(args.settleMs);
    }

    let snapshot = await takeSettledSnapshot(cdp, sessionId, args, targetUrl);
    let retryCount = 0;
    while (
      targetUrl &&
      !args.inspectCurrentPage &&
      snapshot.classification === 'limited_view' &&
      retryCount < args.limitedViewRetries
    ) {
      retryCount += 1;
      try {
        const retryNavigationError = await navigateAndWait(cdp, sessionId, targetUrl, args.timeoutMs, args.settleMs);
        if (retryNavigationError) {
          navigationError = retryNavigationError;
        }
        snapshot = await takeSettledSnapshot(cdp, sessionId, args, targetUrl);
      } catch (error) {
        navigationError = String(error);
        break;
      }
    }

    if (retryCount > 0) {
      snapshot.retryCount = retryCount;
    }

    if (targetUrl && !hasPopularTimesSignal(snapshot) && snapshot.classification !== 'limited_view') {
      const waitMs = Math.max(0, Math.min(args.popularTimesWaitMs, args.timeoutMs));
      if (waitMs > 0) {
        snapshot = await waitForPopularTimesSnapshot(cdp, sessionId, waitMs, args.includeDumps, snapshot);
      }
    }

    if (targetUrl && args.postDetachResample && isWeakNavigationSnapshot(snapshot)) {
      await session.close();
      session = null;
      await sleep(Math.max(1000, Math.min(args.settleMs, 3000)));
      session = await openBrowserSession({ ...args, inspectCurrentPage: true });
      snapshot = await takeSettledSnapshot(session.cdp, session.sessionId, args, null);
      snapshot.postDetachResample = true;
    }

    if (navigationError) {
      snapshot.navigationError = navigationError;
    }

    console.log(JSON.stringify(snapshot, null, 2));
  } finally {
    if (session) {
      await session.close();
    }
  }
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((error) => {
    const errorText = String(error);
    const output = { error: errorText };
    const hint = buildCrashHint(errorText);
    if (hint) {
      output.hint = hint;
    }
    console.error(JSON.stringify(output, null, 2));
    process.exit(1);
  });
}
