import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { promisify } from 'node:util';

/**
 * A Patchright-shaped Page over the user's OWN signed-in Google Chrome.
 *
 * The engine was only ever run inside a headless Chromium it launched itself,
 * which is why it never filed one of his applications: his sessions, logins and
 * open forms live in his Chrome. CDP into that Chrome needs a relaunch with a
 * debug port (Chrome 136+ refuses it on the default profile), so this drives it
 * through AppleScript `execute javascript` instead — the same channel the hand
 * fills used. No Accessibility permission, works on a background tab.
 *
 * Only the subset of Page the engine calls is implemented. Every event is
 * synthetic (isTrusted=false); React/Angular/Wiz forms accept those for value
 * entry, which is what the engine needs.
 */

const run = promisify(execFile);

// Finds the tab once by URL substring (or the front window's active tab), then
// pins it by id so focus changes in Chrome can't redirect a fill mid-form.
const JXA = `function run(argv){
  var c = Application("Google Chrome"), id = argv[0], want = argv[1], code = argv[2];
  var tab = null;
  c.windows().some(function(w){ return w.tabs().some(function(t){
    if ((id && String(t.id()) === id) || (!id && want && t.url().indexOf(want) >= 0)) { tab = t; return true; }
  }); });
  if (!tab && !id && !want) tab = c.windows[0].activeTab();
  if (!tab) throw new Error("no Chrome tab " + (id || want));
  if (code === "__ID__") return String(tab.id());
  if (code === "__URL__") return tab.url();
  if (code.indexOf("__GOTO__") === 0) { tab.url = code.slice(8); return ""; }
  var r = tab.execute({ javascript: code });
  return r === undefined || r === null ? "" : String(r);
}`;

// Same contract over Safari (AF_BROWSER=safari). Safari tabs have no id, so a
// tab is pinned as "<windowId>:<tabIndex>". Needs Develop > Allow JavaScript
// from Apple Events.
const SAFARI_JXA = `function run(argv){
  var s = Application("Safari"), id = argv[0], want = argv[1], code = argv[2];
  var tab = null, tid = "";
  s.windows().some(function(w){ return w.tabs().some(function(t, i){
    var k = w.id() + ":" + i;
    if ((id && k === id) || (!id && want && String(t.url()).indexOf(want) >= 0)) { tab = t; tid = k; return true; }
  }); });
  if (!tab && !id && !want) { var w0 = s.windows[0]; tab = w0.currentTab(); tid = w0.id() + ":" + (tab.index() - 1); }
  if (!tab) throw new Error("no Safari tab " + (id || want));
  if (code === "__ID__") return tid;
  if (code === "__URL__") return String(tab.url());
  if (code.indexOf("__GOTO__") === 0) { tab.url = code.slice(8); return ""; }
  var r = s.doJavaScript(code, { in: tab });
  return r === undefined || r === null ? "" : String(r);
}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ChromePage {
  evaluate<R = any>(fn: ((arg: any) => R) | string, arg?: unknown): Promise<Awaited<R>>;
  click(selector: string, opts?: unknown): Promise<void>;
  keyboard: { press(key: string): Promise<void>; type(text: string, opts?: unknown): Promise<void> };
  setInputFiles(selector: string, path: string): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<void>;
  waitForLoadState(state?: string, opts?: { timeout?: number }): Promise<void>;
  goto(url: string, opts?: unknown): Promise<void>;
  url(): string;
  screenshot(opts?: unknown): Promise<Buffer>;
  tabId: string;
}

export async function chromePage(match = ''): Promise<ChromePage> {
  const raw = async (id: string, code: string): Promise<string> => {
    const jxa = process.env.AF_BROWSER === 'safari' ? SAFARI_JXA : JXA;
    const { stdout } = await run('osascript', ['-l', 'JavaScript', '-e', jxa, id, match, code], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.replace(/\n$/, '');
  };
  const tabId = await raw('', '__ID__');
  let currentUrl = await raw(tabId, '__URL__');
  const exec = (code: string) => raw(tabId, code);

  /** Run a function in the page; JSON in, JSON out, promises awaited by polling. */
  async function evaluate(fn: any, arg?: unknown): Promise<any> {
    const body = typeof fn === 'function' ? `(${fn.toString()})(${JSON.stringify(arg ?? null)})` : String(fn);
    const out = await exec(`(function(){try{var r=${body};
      if(r&&typeof r.then==="function"){window.__afP={d:0};r.then(function(v){window.__afP={d:1,v:v===undefined?null:v}},function(e){window.__afP={d:1,e:String(e&&e.stack||e)}});return "__AF_ASYNC__";}
      return JSON.stringify({v:r===undefined?null:r});}catch(e){return JSON.stringify({e:String(e&&e.stack||e)});}})()`);
    let res: any;
    if (out === '__AF_ASYNC__') {
      for (let i = 0; i < 600; i++) {
        await sleep(50);
        const p = await exec('JSON.stringify(window.__afP)');
        res = JSON.parse(p || '{"d":0}');
        if (res.d) break;
      }
    } else {
      res = JSON.parse(out || '{"v":null}');
    }
    if (res.e) throw new Error(`in-page: ${res.e}`);
    return res.v;
  }

  // Full pointer sequence: react-select opens on mousedown, most others on click.
  const click = async (selector: string) => {
    const ok = await evaluate((sel: string) => {
      const el = document.querySelector(sel) as any;
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
      el.dispatchEvent(new PointerEvent('pointerdown', o));
      el.dispatchEvent(new MouseEvent('mousedown', o));
      if (el.focus) el.focus();
      el.dispatchEvent(new PointerEvent('pointerup', o));
      el.dispatchEvent(new MouseEvent('mouseup', o));
      el.click();
      return true;
    }, selector);
    if (!ok) throw new Error(`click: no element ${selector}`);
  };

  // Keys go to whatever has focus, as with a real keyboard. Cmd/Ctrl+A arms a
  // replace for the next type(), which is all the engine uses it for.
  let replaceNext = false;
  const keyboard = {
    async press(key: string) {
      if (/^(ControlOrMeta|Meta|Control)\+a$/i.test(key)) {
        replaceNext = true;
        return;
      }
      await evaluate((k: string) => {
        const el = (document.activeElement || document.body) as any;
        const o = { key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, bubbles: true, cancelable: true, composed: true };
        el.dispatchEvent(new KeyboardEvent('keydown', o));
        el.dispatchEvent(new KeyboardEvent('keyup', o));
        return true;
      }, key);
    },
    async type(text: string) {
      const replace = replaceNext;
      replaceNext = false;
      await evaluate(({ text, replace }: { text: string; replace: boolean }) => {
        const el = document.activeElement as any;
        if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const set = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
        set.call(el, replace ? text : el.value + text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }));
        return true;
      }, { text, replace });
    },
  };

  /** Attach a local file without the OS file dialog: bytes → File → DataTransfer. */
  const setInputFiles = async (selector: string, path: string) => {
    const b64 = readFileSync(path).toString('base64');
    const name = basename(path);
    const type = /\.pdf$/i.test(name) ? 'application/pdf' : 'application/octet-stream';
    const ok = await evaluate(({ sel, b64, name, type }: { sel: string; b64: string; name: string; type: string }) => {
      const el = document.querySelector(sel) as any;
      if (!el) return false;
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type }));
      el.files = dt.files;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.files.length === 1;
    }, { sel: selector, b64, name, type });
    if (!ok) throw new Error(`setInputFiles: could not attach to ${selector}`);
  };

  const waitForSelector = async (selector: string, opts: { timeout?: number } = {}) => {
    const end = Date.now() + (opts.timeout ?? 15000);
    while (Date.now() < end) {
      if (await evaluate((s: string) => !!document.querySelector(s), selector)) return;
      await sleep(150);
    }
    throw new Error(`waitForSelector timeout: ${selector}`);
  };

  return {
    tabId,
    evaluate,
    click,
    keyboard,
    setInputFiles,
    waitForSelector,
    waitForTimeout: sleep,
    async waitForLoadState(_s?: string, opts: { timeout?: number } = {}) {
      const end = Date.now() + (opts.timeout ?? 15000);
      while (Date.now() < end && (await evaluate(() => document.readyState)) !== 'complete') await sleep(150);
    },
    async goto(url: string) {
      if (url === currentUrl) return; // the form he opened is already the target
      await exec('__GOTO__' + url);
      currentUrl = url;
      await sleep(500);
      await this.waitForLoadState();
    },
    url: () => currentUrl,
    // ponytail: no capture of a background tab via AppleScript; the readback
    // table is the review surface. Upgrade: `screencapture -l <windowid>`.
    async screenshot() {
      return Buffer.alloc(0);
    },
  };
}
