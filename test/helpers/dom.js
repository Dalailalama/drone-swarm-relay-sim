// Minimal DOM harness so the browser-only UI (js/main.js) can be booted and
// driven from Node tests.
//
// helpers/sim.js loads the *pure* sim modules into one vm context. This file
// does the same thing for the whole page: it builds the vm context, stubs the
// slice of the browser main.js actually touches, then runs every
// `<script src="js/...">` from index.html in document order — main.js last, so
// loadUI() returns only after the real boot sequence (resetSwarm() and friends)
// has completed. Nothing under js/ is modified or patched; every
// accommodation lives here.
//
// The element stubs are deliberately dumb objects, not a DOM implementation.
// Two places where we knowingly deviate from the real DOM, because faking the
// real behaviour would need a layout engine we do not have:
//
//   * `<select>.value` is lenient — assigning a value that matches no <option>
//     keeps the value instead of resetting it to ''. main.js assigns ids
//     ('x8', 'rfd900x', a calibrated preset id) before/without the matching
//     option always existing, and a strict select would silently blank them.
//     Appending the first <option> still seeds the value, like a real select.
//   * `textContent` and `innerHTML` are independent properties; setting one
//     does not rewrite the other (no serializer, no child-node model).
//
// Everything else that main.js uses (ids, classes, the parent chain that
// `closest()` walks, checkbox `checked` defaults, range/`select` initial
// values) is parsed out of the real index.html, so the booted UI starts in the
// same state the page does.
//
// Usage:
//   const { loadUI, makeFile } = require('./helpers/dom.js');
//   const { ctx, el, fire } = loadUI();
//   ctx.sim.swarm.drones.length;     // the live swarm
//   el('countOut').textContent;      // any element, by id
//   fire('resetBtn', 'click');       // drive a control
//   el('videoChk').click();          // checkbox: flips .checked, fires change
//   ctx.__raf.pump(16);              // run one animation frame by hand
//
// fire(id, type) only dispatches — it does not mutate the element first, so a
// slider test sets `el('countRange').value = 24` before firing 'change', just
// like the browser would have.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');

// --- index.html parsing ------------------------------------------------------
// A tag-level scanner, not a spec parser: enough to recover the element tree
// (so parentElement/closest work), each element's attributes, and the script
// list. index.html is hand-written, well-formed markup, so this holds.

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// <tag attrs> / </tag>. Quoted attribute values may contain '>' (index.html's
// inline SVG favicon does), hence the quote-aware alternation.
const TAG_RE = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;

function parseAttrs(raw) {
  const attrs = {};
  const re = /([:@\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    const name = m[1].toLowerCase();
    if (name === '/') continue;
    const val = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    attrs[name] = val;
  }
  return attrs;
}

function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null, start: 0, end: html.length };
  const stack = [root];
  const nodes = [];
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(html))) {
    const tag = m[2].toLowerCase();
    const attrsRaw = m[3] || '';
    if (m[1] === '/') {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack[i].end = m.index; stack.length = i; break; }
      }
      continue;
    }
    const node = {
      tag,
      attrs: parseAttrs(attrsRaw),
      children: [],
      parent: stack[stack.length - 1],
      start: TAG_RE.lastIndex,
      end: TAG_RE.lastIndex,
    };
    node.parent.children.push(node);
    nodes.push(node);
    if (!/\/\s*$/.test(attrsRaw) && !VOID_TAGS.has(tag)) stack.push(node);
  }
  while (stack.length > 1) {
    const n = stack.pop();
    if (n.end < n.start) n.end = html.length;
  }
  return { root, nodes };
}

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
  '&middot;': '·', '&hellip;': '…', '&times;': '×', '&deg;': '°',
  '&harr;': '↔', '&rarr;': '→', '&copy;': '©',
};
function decodeEntities(s) {
  return s.replace(/&[#\w]+;/g, e => (e in ENTITIES ? ENTITIES[e] : e));
}
function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}
function camel(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// --- tiny selector matcher ---------------------------------------------------
// Single compound selectors only: `#id`, `.cls`, `tag`, `[attr]`, `[attr="v"]`
// and concatenations of those. Descendant/child combinators are NOT supported
// (main.js never uses one); an unsupported selector simply matches nothing.

function attrValue(el, name) {
  if (name === 'id') return el.id || null;
  if (name === 'class') return el.className || null;
  if (name.startsWith('data-')) {
    const k = camel(name.slice(5));
    return k in el.dataset ? el.dataset[k] : null;
  }
  if (el.__attrs && name in el.__attrs) return el.__attrs[name];
  const v = el[name];
  return v === undefined ? null : v;
}

function matchesSelector(el, sel) {
  const parts = String(sel).trim().match(/\[[^\]]*\]|[#.]?[\w-]+|\*/g);
  if (!parts) return false;
  for (const p of parts) {
    if (p === '*') continue;
    if (p[0] === '#') {
      if (el.id !== p.slice(1)) return false;
    } else if (p[0] === '.') {
      if (!el.classList.contains(p.slice(1))) return false;
    } else if (p[0] === '[') {
      const m = /^\[\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]]*?))\s*)?\]$/.exec(p);
      if (!m) return false;
      const v = attrValue(el, m[1]);
      if (v == null) return false;
      if (m[0].includes('=')) {
        const want = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
        if (String(v) !== String(want)) return false;
      }
    } else if (el.tagName.toLowerCase() !== p.toLowerCase()) {
      return false;
    }
  }
  return true;
}

// --- canvas 2d context stub --------------------------------------------------
// Boot never draws (requestAnimationFrame is queued, not run), but a test that
// pumps a frame runs the real render.js/view3d.js against this.

function makeCanvasContext(canvas) {
  const c = {
    canvas,
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    globalAlpha: 1, globalCompositeOperation: 'source-over', font: '10px sans-serif',
    textAlign: 'start', textBaseline: 'alphabetic', imageSmoothingEnabled: true,
    shadowBlur: 0, shadowColor: 'transparent', miterLimit: 10, filter: 'none',
    calls: 0,
  };
  const noop = [
    'save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'arcTo',
    'rect', 'roundRect', 'ellipse', 'quadraticCurveTo', 'bezierCurveTo', 'fill', 'stroke',
    'clip', 'fillRect', 'strokeRect', 'clearRect', 'fillText', 'strokeText', 'setLineDash',
    'translate', 'rotate', 'scale', 'transform', 'setTransform', 'resetTransform',
    'drawImage', 'putImageData', 'drawFocusIfNeeded', 'scrollPathIntoView',
  ];
  for (const k of noop) c[k] = function () { c.calls++; };
  c.getLineDash = () => [];
  c.measureText = (t) => ({ width: String(t == null ? '' : t).length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
  c.createLinearGradient = () => ({ addColorStop() {} });
  c.createRadialGradient = () => ({ addColorStop() {} });
  c.createPattern = () => null;
  c.getImageData = (x, y, w, h) => ({
    width: Math.max(1, w | 0), height: Math.max(1, h | 0),
    data: new Uint8ClampedArray(Math.max(1, w | 0) * Math.max(1, h | 0) * 4),
  });
  c.createImageData = (w, h) => c.getImageData(0, 0, w, h);
  c.isPointInPath = () => false;
  return c;
}

/**
 * Boot the whole browser UI inside a vm context.
 *
 * @param {object} [opts]
 * @param {Function} [opts.fetch]        replacement for the rejecting fetch stub
 * @param {Function} [opts.WebSocket]    replacement WebSocket class
 * @param {string[]} [opts.scripts]      override the script list (default: index.html's)
 * @param {{width:number,height:number}} [opts.viewport]  getBoundingClientRect box (default 800x600)
 * @param {number} [opts.devicePixelRatio]
 * @param {object} [opts.globals]        extra globals merged into the context
 * @returns {{ctx:object, el:(id:string)=>object, fire:(id:string,type:string,ev?:object)=>object,
 *            document:object, querySelector:(sel:string)=>object}}
 */
function loadUI(opts) {
  const o = opts || {};
  const viewport = o.viewport || { width: 800, height: 600 };
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const { root, nodes } = parseHtml(html);

  const scripts = o.scripts || nodes
    .filter(n => n.tag === 'script' && n.attrs.src && n.attrs.src.startsWith('js/'))
    .map(n => n.attrs.src);

  const byId = new Map();       // id -> element (tree-backed or auto-created)
  const byNode = new Map();     // parsed node -> element
  const created = [];           // everything document.createElement() made
  const clock = { ms: 0 };

  // --- element factory -------------------------------------------------------
  function makeElement(tag, node) {
    const listeners = new Map();
    const classes = new Set();
    let value = '';
    let valueSet = false;       // explicit assignment (vs. seeded from options)
    let parentOverride;         // set by appendChild on detached elements
    let childList = null;

    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      nodeName: String(tag || 'div').toUpperCase(),
      nodeType: 1,
      id: (node && node.attrs.id) || '',
      __node: node || null,
      __attrs: node ? Object.assign({}, node.attrs) : {},
      textContent: node ? stripTags(html.slice(node.start, node.end)) : '',
      innerHTML: node ? html.slice(node.start, node.end).trim() : '',
      checked: node ? 'checked' in node.attrs : false,
      disabled: node ? 'disabled' in node.attrs : false,
      selected: false,
      readOnly: false,
      hidden: false,
      title: (node && node.attrs.title) || '',
      type: (node && node.attrs.type) || '',
      name: (node && node.attrs.name) || '',
      placeholder: (node && node.attrs.placeholder) || '',
      href: (node && node.attrs.href) || '',
      src: (node && node.attrs.src) || '',
      download: '',
      min: (node && node.attrs.min) || '',
      max: (node && node.attrs.max) || '',
      step: (node && node.attrs.step) || '',
      accept: (node && node.attrs.accept) || '',
      width: 0,
      height: 0,
      scrollTop: 0,
      scrollHeight: 0,
      offsetWidth: viewport.width,
      offsetHeight: viewport.height,
      files: [],
      options: [],
      dataset: {},
      style: {},
      __listeners: listeners,
    };

    el.style.setProperty = (k, v) => { el.style[camel(k)] = v; };
    el.style.getPropertyValue = (k) => el.style[camel(k)] || '';
    el.style.removeProperty = (k) => { delete el.style[camel(k)]; };

    if (node) {
      for (const [k, v] of Object.entries(node.attrs)) {
        if (k.startsWith('data-')) el.dataset[camel(k.slice(5))] = v;
      }
      if (node.attrs.class) node.attrs.class.split(/\s+/).filter(Boolean).forEach(c => classes.add(c));
      if (node.attrs.style) {
        for (const decl of node.attrs.style.split(';')) {
          const i = decl.indexOf(':');
          if (i > 0) el.style[camel(decl.slice(0, i).trim())] = decl.slice(i + 1).trim();
        }
      }
    }

    Object.defineProperty(el, 'value', {
      enumerable: true,
      get() { return value; },
      set(v) { value = v == null ? '' : String(v); valueSet = true; },
    });
    Object.defineProperty(el, 'className', {
      enumerable: true,
      get() { return [...classes].join(' '); },
      set(v) { classes.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
    });
    Object.defineProperty(el, 'parentElement', {
      enumerable: true,
      get() {
        if (parentOverride !== undefined) return parentOverride;
        if (node && node.parent && node.parent.tag !== '#root') return elementFor(node.parent);
        return null;
      },
      set(v) { parentOverride = v; },
    });
    Object.defineProperty(el, 'parentNode', {
      get() { return el.parentElement; },
      set(v) { el.parentElement = v; },
    });
    Object.defineProperty(el, 'children', {
      get() {
        if (!childList) childList = node ? node.children.map(elementFor) : [];
        return childList;
      },
    });
    Object.defineProperty(el, 'firstChild', { get() { return el.children[0] || null; } });
    Object.defineProperty(el, 'lastChild', { get() { return el.children[el.children.length - 1] || null; } });

    el.classList = {
      add(...names) { names.forEach(n => classes.add(n)); },
      remove(...names) { names.forEach(n => classes.delete(n)); },
      toggle(n, force) {
        const on = force === undefined ? !classes.has(n) : !!force;
        if (on) classes.add(n); else classes.delete(n);
        return on;
      },
      contains(n) { return classes.has(n); },
      replace(a, b) { if (classes.delete(a)) { classes.add(b); return true; } return false; },
      get length() { return classes.size; },
      item(i) { return [...classes][i] || null; },
      toString() { return [...classes].join(' '); },
    };

    el.appendChild = (child) => {
      if (!child) return child;
      if (!childList) childList = node ? node.children.map(elementFor) : [];
      childList.push(child);
      child.parentElement = el;
      if (el.tagName === 'SELECT' && child.tagName === 'OPTION') {
        el.options.push(child);
        // A real <select> adopts the first option's value; later appends don't
        // move the selection, and an explicit assignment always wins.
        if (!valueSet && el.options.length === 1) value = String(child.value);
      }
      return child;
    };
    el.append = (...kids) => { kids.forEach(k => { if (k && k.tagName) el.appendChild(k); }); };
    el.removeChild = (child) => {
      if (!childList) return child;
      const i = childList.indexOf(child);
      if (i >= 0) childList.splice(i, 1);
      const j = el.options.indexOf(child);
      if (j >= 0) el.options.splice(j, 1);
      return child;
    };
    el.remove = () => { const p = el.parentElement; if (p && p.removeChild) p.removeChild(el); };
    el.insertBefore = (child) => el.appendChild(child);
    el.cloneNode = () => {
      const copy = makeElement(tag, null);
      copy.id = el.id;
      copy.value = el.value;
      copy.className = el.className;
      Object.assign(copy.dataset, el.dataset);
      Object.assign(copy.style, el.style);
      created.push(copy);
      return copy;
    };

    el.setAttribute = (k, v) => {
      el.__attrs[k] = String(v);
      if (k === 'id') el.id = String(v);
      else if (k === 'class') el.className = String(v);
      else if (k === 'value') el.value = v;
      else if (k.startsWith('data-')) el.dataset[camel(k.slice(5))] = String(v);
    };
    el.getAttribute = (k) => {
      const v = attrValue(el, k);
      return v == null ? null : String(v);
    };
    el.hasAttribute = (k) => attrValue(el, k) != null;
    el.removeAttribute = (k) => { delete el.__attrs[k]; };

    el.addEventListener = (type, fn) => {
      if (typeof fn !== 'function') return;
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    };
    el.removeEventListener = (type, fn) => {
      const list = listeners.get(type);
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
    // Invoke everything registered for `type`. `ev` is merged into a minimal
    // event object (target defaults to this element).
    el.fire = (type, ev) => {
      const evt = Object.assign({ type, bubbles: true, defaultPrevented: false }, ev);
      if (!evt.target) evt.target = el;
      evt.currentTarget = el;
      evt.preventDefault = () => { evt.defaultPrevented = true; };
      evt.stopPropagation = () => {};
      evt.stopImmediatePropagation = () => {};
      const list = listeners.get(type);
      if (list) for (const fn of list.slice()) fn.call(el, evt);
      const on = el['on' + type];
      if (typeof on === 'function') on.call(el, evt);
      return evt;
    };
    el.dispatchEvent = (evt) => { el.fire(evt && evt.type, evt); return true; };
    el.click = () => {
      // A real <a download> click is what actually saves a file; record it so
      // tests can assert on exports without a filesystem.
      if (el.download) ctx.__downloads.push({ name: el.download, href: el.href, text: blobTextFor(el.href) });
      const evt = el.fire('click', { detail: 1 });
      // Browsers flip a checkbox/radio and then fire input+change. Firing
      // 'change' directly does NOT flip it — set .checked yourself first.
      if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio') && !evt.defaultPrevented) {
        el.checked = el.type === 'radio' ? true : !el.checked;
        el.fire('input', {});
        el.fire('change', {});
      }
      return evt;
    };
    el.focus = () => {};
    el.blur = () => {};
    el.setPointerCapture = () => {};
    el.releasePointerCapture = () => {};
    el.hasPointerCapture = () => false;
    el.scrollIntoView = () => {};
    el.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0,
      right: viewport.width, bottom: viewport.height,
      width: viewport.width, height: viewport.height,
    });
    el.matches = (sel) => matchesSelector(el, sel);
    el.closest = (sel) => {
      let cur = el;
      while (cur) {
        if (matchesSelector(cur, sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    };
    el.querySelector = (sel) => {
      for (const d of descendants(el)) if (matchesSelector(d, sel)) return d;
      return null;
    };
    el.querySelectorAll = (sel) => descendants(el).filter(d => matchesSelector(d, sel));
    el.contains = (other) => other === el || descendants(el).includes(other);

    if (el.tagName === 'CANVAS') {
      let c2d = null;
      el.width = viewport.width;
      el.height = viewport.height;
      el.getContext = () => (c2d || (c2d = makeCanvasContext(el)));
      el.toDataURL = () => 'data:image/png;base64,';
    }

    // Seed <select>/<input> values from the markup.
    if (node) {
      if (node.attrs.value !== undefined) { value = String(node.attrs.value); valueSet = false; }
      if (el.tagName === 'SELECT') {
        el.options = node.children.filter(n => n.tag === 'option').map(elementFor);
        if (!valueSet && el.options.length) value = String(el.options[0].value);
      }
      if (el.tagName === 'OPTION' && node.attrs.value === undefined) value = el.textContent;
    }
    return el;
  }

  function descendants(el) {
    const out = [];
    const walk = (e) => { for (const c of e.children) { out.push(c); walk(c); } };
    walk(el);
    return out;
  }

  function elementFor(node) {
    let el = byNode.get(node);
    if (!el) {
      el = makeElement(node.tag, node);
      byNode.set(node, el);
      if (el.id && !byId.has(el.id)) byId.set(el.id, el);
    }
    return el;
  }

  const nodeById = new Map();
  for (const n of nodes) if (n.attrs.id && !nodeById.has(n.attrs.id)) nodeById.set(n.attrs.id, n);

  function getElementById(id) {
    const key = String(id);
    if (byId.has(key)) return byId.get(key);
    const node = nodeById.get(key);
    if (node) return elementFor(node);
    // Unknown id: hand back a detached stub (cached) rather than null, so a
    // lookup for markup the harness didn't model can never crash the boot.
    const el = makeElement('div', null);
    el.id = key;
    byId.set(key, el);
    return el;
  }

  function allElements() {
    return nodes.map(elementFor).concat(created);
  }

  const bodyNode = nodes.find(n => n.tag === 'body');
  const headNode = nodes.find(n => n.tag === 'head');
  const htmlNode = nodes.find(n => n.tag === 'html');
  const docListeners = new Map();

  const document = {
    nodeType: 9,
    title: 'drone swarm relay simulator',
    readyState: 'complete',
    getElementById,
    getElementsByTagName: (tag) => allElements().filter(e => e.tagName === String(tag).toUpperCase()),
    getElementsByClassName: (cls) => allElements().filter(e => e.classList.contains(cls)),
    querySelector(sel) {
      for (const e of allElements()) if (matchesSelector(e, sel)) return e;
      return null;
    },
    querySelectorAll(sel) {
      return allElements().filter(e => matchesSelector(e, sel));
    },
    createElement(tag) {
      const el = makeElement(tag, null);
      created.push(el);
      return el;
    },
    createElementNS(_ns, tag) { return document.createElement(tag); },
    createTextNode(text) { return { nodeType: 3, textContent: String(text) }; },
    createDocumentFragment() { return document.createElement('div'); },
    addEventListener(type, fn) {
      if (typeof fn !== 'function') return;
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = docListeners.get(type);
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    dispatchEvent(evt) { document.__fire(evt && evt.type, evt); return true; },
    __fire(type, ev) {
      const evt = Object.assign({ type, target: document, preventDefault() {}, stopPropagation() {} }, ev);
      const list = docListeners.get(type);
      if (list) for (const fn of list.slice()) fn.call(document, evt);
      return evt;
    },
    __listeners: docListeners,
  };
  Object.defineProperty(document, 'body', { get: () => (bodyNode ? elementFor(bodyNode) : null), enumerable: true });
  Object.defineProperty(document, 'head', { get: () => (headNode ? elementFor(headNode) : null), enumerable: true });
  Object.defineProperty(document, 'documentElement', { get: () => (htmlNode ? elementFor(htmlNode) : null) });

  // --- non-DOM browser surface ------------------------------------------------
  const objectUrls = new Map();
  function blobTextFor(url) {
    const b = objectUrls.get(url);
    if (!b) return null;
    return typeof b.__text === 'string' ? b.__text : null;
  }

  class Blob {
    constructor(parts, options) {
      this.__parts = (parts || []).map(p => (p == null ? '' : String(p)));
      this.type = (options && options.type) || '';
    }
    get __text() { return this.__parts.join(''); }
    get size() { return this.__text.length; }
    text() { return Promise.resolve(this.__text); }
    slice() { return this; }
  }

  function fileText(file) {
    if (file == null) return '';
    if (typeof file === 'string') return file;
    if (typeof file.__text === 'string') return file.__text;
    if (typeof file.text === 'string') return file.text;
    if (typeof file.content === 'string') return file.content;
    if (Array.isArray(file.parts)) return file.parts.join('');
    return '';
  }

  // Synchronous on purpose: a test can fire a change event and assert on the
  // result in the same tick. (Real FileReader is async.)
  class FileReader {
    constructor() {
      this.result = null; this.error = null; this.readyState = 0;
      this.onload = null; this.onloadend = null; this.onerror = null; this.onabort = null;
    }
    __done(result) {
      this.result = result;
      this.readyState = 2;
      const ev = { type: 'load', target: this };
      if (typeof this.onload === 'function') this.onload(ev);
      if (typeof this.onloadend === 'function') this.onloadend({ type: 'loadend', target: this });
    }
    readAsText(file) { this.__done(fileText(file)); }
    readAsDataURL(file) { this.__done('data:;base64,' + Buffer.from(fileText(file), 'utf8').toString('base64')); }
    readAsArrayBuffer(file) {
      const buf = Buffer.from(fileText(file), 'utf8');
      this.__done(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    }
    readAsBinaryString(file) { this.__done(fileText(file)); }
    abort() { if (typeof this.onabort === 'function') this.onabort({ type: 'abort', target: this }); }
    addEventListener(type, fn) { this['on' + type] = fn; }
  }

  class HarnessURL extends URL {}
  let urlSeq = 0;
  HarnessURL.createObjectURL = (blob) => {
    const url = 'blob:harness/' + (++urlSeq);
    objectUrls.set(url, blob);
    return url;
  };
  HarnessURL.revokeObjectURL = (url) => { objectUrls.delete(url); };

  const sockets = [];
  class WebSocketStub {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = WebSocketStub.CONNECTING;
      this.sent = [];
      this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
      sockets.push(this);
    }
    send(data) { this.sent.push(data); }
    close() {
      this.readyState = WebSocketStub.CLOSED;
      if (typeof this.onclose === 'function') this.onclose({ type: 'close' });
    }
    addEventListener(type, fn) { this['on' + type] = fn; }
    removeEventListener(type) { this['on' + type] = null; }
    // Test helpers: drive the fake connection by hand.
    __open() { this.readyState = WebSocketStub.OPEN; if (this.onopen) this.onopen({ type: 'open' }); }
    __message(data) { if (this.onmessage) this.onmessage({ type: 'message', data }); }
  }
  WebSocketStub.CONNECTING = 0;
  WebSocketStub.OPEN = 1;
  WebSocketStub.CLOSING = 2;
  WebSocketStub.CLOSED = 3;

  class ResizeObserverStub {
    constructor(cb) { this.callback = cb; this.targets = []; }
    observe(target) { this.targets.push(target); }
    unobserve(target) { const i = this.targets.indexOf(target); if (i >= 0) this.targets.splice(i, 1); }
    disconnect() { this.targets.length = 0; }
    // Test helper: re-run the layout callback (main.js resizes the canvas here).
    __trigger() { this.callback([], this); }
  }

  class ImageStub {
    constructor() {
      this.width = 0; this.height = 0; this.complete = false;
      this.onload = null; this.onerror = null; this.crossOrigin = null;
      this._src = '';
    }
    get src() { return this._src; }
    set src(v) { this._src = String(v); } // no network: neither handler fires
    addEventListener(type, fn) { this['on' + type] = fn; }
  }

  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
    setItem: (k, v) => { store.set(String(k), String(v)); },
    removeItem: (k) => { store.delete(String(k)); },
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };

  // requestAnimationFrame stores callbacks; nothing runs until a test pumps.
  const raf = {
    queue: [],
    nextId: 1,
    frames: 0,
    get pending() { return raf.queue.length; },
    // Advance the fake clock by dtMs and run every queued callback once.
    pump(dtMs) {
      clock.ms += dtMs === undefined ? 16 : dtMs;
      const due = raf.queue.splice(0, raf.queue.length);
      for (const entry of due) entry.fn(clock.ms);
      raf.frames++;
      return due.length;
    },
    clear() { raf.queue.length = 0; },
  };

  const timers = { queue: [], nextId: 1 };
  function addTimer(fn, ms, repeat) {
    const id = timers.nextId++;
    timers.queue.push({ id, fn, ms, repeat });
    return id;
  }
  function clearTimer(id) {
    const i = timers.queue.findIndex(t => t.id === id);
    if (i >= 0) timers.queue.splice(i, 1);
  }
  // Fake timers: nothing fires on its own (a live timer would keep the test
  // process alive and make results non-deterministic). ctx.__timers.run() fires
  // everything currently scheduled.
  timers.run = () => {
    const due = timers.queue.slice();
    for (const t of due) { if (!t.repeat) clearTimer(t.id); t.fn(); }
    return due.length;
  };

  const defaultFetch = () => Promise.reject(new Error('fetch is disabled in the DOM harness — pass opts.fetch'));

  const sandbox = {
    console, Math, Date, JSON, isFinite, isNaN, parseFloat, parseInt,
    Promise, URL: HarnessURL, URLSearchParams, TextEncoder, TextDecoder,
    Buffer, Uint8Array, Uint8ClampedArray, Float32Array, Float64Array, Int32Array, ArrayBuffer,
    document,
    Blob,
    FileReader,
    File: Blob,
    Image: ImageStub,
    ResizeObserver: ResizeObserverStub,
    IntersectionObserver: ResizeObserverStub,
    MutationObserver: ResizeObserverStub,
    WebSocket: o.WebSocket || WebSocketStub,
    localStorage,
    sessionStorage: localStorage,
    navigator: {
      userAgent: 'node-dom-harness', language: 'en-US', languages: ['en-US'],
      platform: 'node', maxTouchPoints: 0, onLine: false, hardwareConcurrency: 4,
      clipboard: { writeText: () => Promise.resolve() },
    },
    performance: { now: () => clock.ms, timeOrigin: 0, mark() {}, measure() {} },
    devicePixelRatio: o.devicePixelRatio === undefined ? 1 : o.devicePixelRatio,
    innerWidth: viewport.width,
    innerHeight: viewport.height,
    screen: { width: viewport.width, height: viewport.height },
    location: { href: 'http://localhost/index.html', protocol: 'http:', host: 'localhost', search: '', hash: '' },
    fetch: o.fetch || defaultFetch,
    requestAnimationFrame(fn) {
      const id = raf.nextId++;
      raf.queue.push({ id, fn });
      return id;
    },
    cancelAnimationFrame(id) {
      const i = raf.queue.findIndex(e => e.id === id);
      if (i >= 0) raf.queue.splice(i, 1);
    },
    setTimeout: (fn, ms) => addTimer(fn, ms, false),
    setInterval: (fn, ms) => addTimer(fn, ms, true),
    clearTimeout: clearTimer,
    clearInterval: clearTimer,
    queueMicrotask: (fn) => { Promise.resolve().then(fn); },
    getComputedStyle: () => ({ getPropertyValue: () => '', display: 'block' }),
    matchMedia: (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    alert(msg) { ctx.__alerts.push(String(msg)); },
    confirm() { return true; },
    prompt() { return null; },
    scrollTo() {},
    open() { return null; },
    // Harness-only handles.
    __raf: raf,
    __timers: timers,
    __sockets: sockets,
    __alerts: [],
    __downloads: [],
    __objectUrls: objectUrls,
    __clock: clock,
  };
  Object.assign(sandbox, o.globals || {});

  const ctx = vm.createContext(sandbox);
  ctx.globalThis = ctx;
  ctx.window = ctx;   // window IS the vm global, so `window.sim = …` -> ctx.sim
  ctx.self = ctx;
  document.defaultView = ctx;

  // window-level events (main.js listens for 'resize').
  const winListeners = new Map();
  ctx.addEventListener = (type, fn) => {
    if (typeof fn !== 'function') return;
    if (!winListeners.has(type)) winListeners.set(type, []);
    winListeners.get(type).push(fn);
  };
  ctx.removeEventListener = (type, fn) => {
    const list = winListeners.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  ctx.dispatchEvent = (evt) => { ctx.__fireWindow(evt && evt.type, evt); return true; };
  ctx.__fireWindow = (type, ev) => {
    const evt = Object.assign({ type, target: ctx, preventDefault() {}, stopPropagation() {} }, ev);
    const list = winListeners.get(type);
    if (list) for (const fn of list.slice()) fn.call(ctx, evt);
    return evt;
  };
  ctx.__fireDocument = (type, ev) => document.__fire(type, ev);
  ctx.__el = getElementById;
  ctx.__document = document;

  for (const src of scripts) {
    const file = path.join(ROOT, src);
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: src });
  }

  return {
    ctx,
    document,
    el: getElementById,
    fire: (id, type, ev) => getElementById(id).fire(type, ev),
    querySelector: (sel) => document.querySelector(sel),
    querySelectorAll: (sel) => document.querySelectorAll(sel),
  };
}

// Convenience for the file-input path: what a test hands to an <input
// type="file"> before firing 'change'. The harness FileReader reads `.text`.
function makeFile(name, text, type) {
  const body = String(text);
  return { name, size: body.length, type: type || 'application/json', text: body, lastModified: 0 };
}

module.exports = { loadUI, makeFile };
