import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createClient } from '../sdk/src/index.ts';
import { seedDemo } from '../server/src/demo-seed.ts';
import { freePort, launchServices } from '../server/src/launcher.ts';
import { removeDir } from './lib.ts';

// Captures README screenshots of the web build in a phone-sized viewport by driving a headless
// Chromium browser (Edge or Chrome) over the DevTools protocol. Requires: npm run build:web
const OUT = resolve('docs/screenshots');
const WIDTH = 390;
const HEIGHT = 844;

const BROWSERS = [
  process.env.BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((p): p is string => Boolean(p));

class Cdp {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
  errors: string[] = [];

  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: { exceptionDetails?: { exception?: { description?: string }; text?: string }; type?: string; args?: { value?: unknown; description?: string }[] };
        result?: unknown;
        error?: { message: string };
      };
      if (message.id !== undefined) this.#pending.get(message.id)?.(message);
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params?.exceptionDetails;
        this.errors.push(details?.exception?.description ?? details?.text ?? 'exception');
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        this.errors.push((message.params.args ?? []).map((a) => String(a.value ?? a.description ?? '')).join(' '));
      }
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new Cdp(ws);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, (message) => {
        this.#pending.delete(id);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result as T);
      });
    });
  }

  async eval<T>(expression: string): Promise<T> {
    const result = await this.send<{ result: { value: T } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return result.result.value;
  }

  close(): void {
    this.#ws.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(page: Cdp, condition: string, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.eval<boolean>(`Boolean(${condition})`)) return;
    await sleep(150);
  }
  const visible = await page.eval<string>('document.body ? document.body.innerText.slice(0, 400) : "(no body)"');
  throw new Error(`Timed out waiting for ${label}. URL: ${await page.eval<string>('location.href')}. Page text: ${visible}. Errors: ${page.errors.join(' | ')}`);
}

const hasText = (text: string) => `document.body && document.body.innerText.includes(${JSON.stringify(text)})`;

async function click(page: Cdp, selector: string): Promise<void> {
  await waitFor(page, `document.querySelector(${JSON.stringify(selector)})`, selector);
  const box = await page.eval<{ x: number; y: number }>(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
}

async function clickText(page: Cdp, text: string): Promise<void> {
  await waitFor(page, hasText(text), `text "${text}"`);
  const box = await page.eval<{ x: number; y: number } | null>(`(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.trim() === ${JSON.stringify(text)}) {
        const el = node.parentElement; el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
    }
    return null;
  })()`);
  if (!box) throw new Error(`No element with text "${text}"`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
}

async function scrollScreen(page: Cdp, testId: string, to: 'top' | 'bottom'): Promise<void> {
  await page.eval(`(() => {
    const el = document.querySelector('[data-testid="${testId}"]');
    if (el) el.scrollTop = ${to === 'top' ? '0' : 'el.scrollHeight'};
  })()`);
  await sleep(300);
}

async function shot(page: Cdp, name: string): Promise<void> {
  await sleep(400);
  const { data } = await page.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  process.stdout.write(`  saved docs/screenshots/${name}.png\n`);
}

if (!existsSync('mobile/dist/index.html')) throw new Error('Build the web app first: npm run build:web');
const browserPath = BROWSERS.find((p) => existsSync(p));
if (!browserPath) throw new Error('No Chrome or Edge found; set BROWSER to its path');
mkdirSync(OUT, { recursive: true });

const dataDir = mkdtempSync(join(tmpdir(), 'pp-shots-'));
const profileDir = mkdtempSync(join(tmpdir(), 'pp-browser-'));
const stack = await launchServices({ dataDir, env: { ...process.env, LOG_LEVEL: 'warn', WEB_DIST: resolve('mobile/dist') } });
const debugPort = await freePort();
const browser = spawn(
  browserPath,
  [`--headless=new`, `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', `--window-size=${WIDTH},${HEIGHT}`, 'about:blank'],
  { stdio: 'ignore' },
);

try {
  const base = stack.urls.gateway;
  await seedDemo(base);
  const asha = createClient({ baseUrl: base, token: (await createClient({ baseUrl: base }).demoLogin('u_asha')).token });
  await asha.setCartItem('IT-MON-P2425H', 2);

  let targets: { type: string; webSocketDebuggerUrl: string }[] = [];
  for (let i = 0; i < 50 && !targets.some((t) => t.type === 'page'); i++) {
    await sleep(200);
    targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json() as Promise<typeof targets>, () => []);
  }
  const page = await Cdp.connect(targets.find((t) => t.type === 'page')!.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Network.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: true });
  const go = async (path: string) => {
    await page.send('Page.navigate', { url: `${base}${path}` });
    await sleep(600);
  };

  process.stdout.write('Capturing screenshots\n');
  await go('/login');
  await click(page, '[data-testid="login-u_asha"]');
  await waitFor(page, hasText('Budgets this month'), 'home screen');
  await waitFor(page, hasText('Bulk-buy savings'), 'home sections');
  await shot(page, 'home');

  await go('/product/OFF-A4-JK75');
  await waitFor(page, hasText('Business volume pricing'), 'product page');
  await clickText(page, '50');
  await sleep(300);
  await shot(page, 'product');

  await go('/cart');
  await waitFor(page, hasText('Approval needed'), 'approval preview');
  await scrollScreen(page, 'cart-screen', 'bottom');
  await shot(page, 'cart');

  await go(`/assistant?prompt=${encodeURIComponent('Order 20 reams of A4 paper and 10 packs of gel pens with GST invoice')}`);
  await waitFor(page, 'document.querySelector(\'[data-testid="confirm-add_to_cart"]\')', 'assistant proposal');
  await clickText(page, 'Confirm');
  await waitFor(page, hasText('Done'), 'confirmed action');
  await shot(page, 'assistant');

  // Offline checkout: the order is saved on the device and sent when the network returns.
  await go('/cart');
  await waitFor(page, hasText('Approval needed'), 'cart');
  await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await click(page, '[data-testid="place-order"]');
  await waitFor(page, hasText('saved on this device'), 'queued order', 30_000);
  await scrollScreen(page, 'cart-screen', 'top');
  await shot(page, 'offline-checkout');
  await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await go('/orders');
  await waitFor(page, `!(${hasText('waiting to be sent')}) && ${hasText('Order #1006')}`, 'queued order delivered after reconnecting', 40_000);
  process.stdout.write('  queued checkout was delivered after reconnecting\n');

  await click(page, '[data-testid="sign-out"]');
  await waitFor(page, hasText('Sign in as a demo user'), 'login');
  await click(page, '[data-testid="login-u_ravi"]');
  await waitFor(page, hasText('waiting for your approval'), 'manager home');
  await go('/approvals');
  await waitFor(page, hasText('Your step'), 'approvals');
  await shot(page, 'approvals');

  const pending = await createClient({ baseUrl: base, token: (await createClient({ baseUrl: base }).demoLogin('u_ravi')).token }).listApprovals();
  await go(`/order/${pending.items[0]!.id}`);
  await waitFor(page, hasText('Your decision'), 'order detail');
  await shot(page, 'order-approval');
  page.close();
} finally {
  browser.kill();
  await stack.stop();
  removeDir(dataDir);
  removeDir(profileDir);
}
