// Stylesheet-lifecycle regressions for the browser half, executed against the
// SHIPPED bundle (lib/client.js) rather than the sources, so a bundling or
// entry-point mistake fails here too.
//
// Why these exist: the stylesheet used to be injected once from `apply()` and
// guarded on the mere presence of a tag carrying this package's `data-plugin`.
// The client module loader removes `style[data-plugin="<package>"]` tags while
// reconciling a row (`removeOwnedStyles`), so the stylesheet could disappear
// from under a mounted plugin and never return — the sidebar action fell back
// to browser default styling and the dialog rendered inline in the sidebar
// instead of as a fixed overlay, until a full page reload. These cases pin the
// self-healing behaviour, the identity of the guard, and the effect's cleanup.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** This stylesheet's identity, as the platform's `data-plugin-css` convention names it. */
const CSS_ID = 'dsh-wsl-workspace/client.css';
const SELECTOR_RE = /^style\[data-plugin-css="(.*)"\]$/;

/** A DOM just large enough to host one injected stylesheet. */
function fakeDom() {
  const head = {
    children: [],
    appendChild(el) { head.children.push(el); return el; },
    removeChild(el) {
      const at = head.children.indexOf(el);
      if (at >= 0) head.children.splice(at, 1);
      return el;
    },
  };
  const observers = [];
  const element = () => {
    const attrs = new Map();
    return {
      tagName: 'STYLE',
      textContent: '',
      setAttribute: (key, value) => attrs.set(key, value),
      getAttribute: key => (attrs.has(key) ? attrs.get(key) : null),
      remove() {
        const at = head.children.indexOf(this);
        if (at >= 0) head.children.splice(at, 1);
      },
    };
  };
  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observers.push(this);
    }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const document = {
    head,
    createElement: element,
    getElementById: () => null,
    querySelector(selector) {
      const match = SELECTOR_RE.exec(selector);
      if (match === null) return null;
      return head.children.find(el => el.getAttribute('data-plugin-css') === match[1]) ?? null;
    },
  };
  return { document, MutationObserver, head, observers, element };
}

/** Mount the shipped bundle over a runtime exposing no version-specific service. */
function mount() {
  const dom = fakeDom();
  const effects = [];
  let plugin;
  const sessions = { list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} } };
  const ctx = {
    get: key => (key === 'sessions' ? sessions : undefined),
    effect: fn => { effects.push(fn()); },
    locale: { register: () => () => {}, bind: () => key => key },
    slots: { inject: (_name, fn) => fn(), register: () => () => {} },
  };
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: { load: mod => { plugin = mod.factory(() => ({})); } },
      setInterval: () => 1,
      clearInterval: () => {},
    },
    console,
    document: dom.document,
    MutationObserver: dom.MutationObserver,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, value: [] }) }),
  });
  plugin.apply(ctx);
  return {
    ...dom,
    styles: () => dom.head.children.filter(el => el.getAttribute('data-plugin-css') === CSS_ID),
    /** What the loader's `removeOwnedStyles('dsh-wsl-workspace')` does to this plugin's tags. */
    loaderRemovesOwnedStyles: () => {
      for (const el of [...dom.head.children]) {
        if (el.getAttribute('data-plugin') === 'dsh-wsl-workspace') el.remove();
      }
    },
    fireMutation: () => dom.observers.at(-1)?.callback(),
    dispose: () => effects.reverse().forEach(fn => { if (typeof fn === 'function') fn(); }),
  };
}

test('the stylesheet is installed once, under both ownership attributes', () => {
  const f = mount();
  const installed = f.styles();
  assert.equal(installed.length, 1);
  assert.equal(installed[0].getAttribute('data-plugin'), 'dsh-wsl-workspace');
  assert.equal(installed[0].getAttribute('data-plugin-css'), CSS_ID);
  assert.ok(installed[0].textContent.includes('.dww-overlay'));
  assert.ok(installed[0].textContent.includes('.dww-action'));
  f.dispose();
});

test('a removal by the module loader is repaired on the next mutation', () => {
  const f = mount();
  f.loaderRemovesOwnedStyles();
  assert.equal(f.styles().length, 0, 'precondition: the loader took the tag away');
  f.fireMutation();
  const restored = f.styles();
  assert.equal(restored.length, 1, 'the stylesheet must come back without a reload');
  assert.equal(restored[0].getAttribute('data-plugin-css'), CSS_ID);
  assert.ok(restored[0].textContent.includes('.dww-overlay'));
  f.dispose();
});

test('another plugin\'s stylesheet never satisfies this one\'s guard', () => {
  const f = mount();
  f.loaderRemovesOwnedStyles();
  // A foreign tag that merely shares the package attribute is not this stylesheet.
  const foreign = f.element();
  foreign.setAttribute('data-plugin', 'dsh-wsl-workspace');
  foreign.setAttribute('data-plugin-css', 'some-other-plugin.css');
  f.head.children.push(foreign);
  f.fireMutation();
  assert.equal(f.styles().length, 1);
  f.dispose();
});

test('the effect disposer takes the stylesheet and the watcher with it', () => {
  const f = mount();
  const observer = f.observers.at(-1);
  f.dispose();
  assert.equal(f.styles().length, 0, 'unloading the plugin must not leave an orphan <style>');
  assert.equal(observer.disconnected, true);
});
