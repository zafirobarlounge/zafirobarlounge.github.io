const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const source = readFileSync(path.join(__dirname, '../src/admin/useModalScrollLock.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function loadScrollLock({ withVisualViewport = true } = {}) {
  const body = { style: { overflow: 'auto', height: '75%', paddingRight: '0px', position: '', top: '', width: '' } };
  const properties = new Map();
  const documentElement = {
    clientWidth: 380,
    style: {
      overflow: '',
      height: '90%',
      overscrollBehavior: '',
      setProperty: (name, value) => properties.set(name, value),
      removeProperty: (name) => properties.delete(name),
    },
  };
  const visualViewport = Object.assign(new EventTarget(), { height: 730, offsetTop: 0 });
  const scrollCalls = [];
  const window = Object.assign(new EventTarget(), {
    scrollX: 0,
    scrollY: 185,
    innerWidth: 390,
    innerHeight: 780,
    visualViewport: withVisualViewport ? visualViewport : undefined,
    scrollTo: (options) => scrollCalls.push({ ...options }),
  });
  const exports = {};
  let cleanup;
  vm.runInNewContext(compiled, {
    exports,
    require: () => ({ useLayoutEffect: (effect) => { cleanup = effect(); } }),
    document: { body, documentElement },
    window,
  });
  const lock = () => {
    exports.useModalScrollLock(true);
    return cleanup;
  };
  return { lock, body, documentElement, properties, visualViewport, window, scrollCalls };
}

test('nested dialogs keep the page locked while resize and viewport scrolling update their position', () => {
  const { lock, body, documentElement, properties, visualViewport, scrollCalls } = loadScrollLock();
  const closeFirst = lock();
  const closeSecond = lock();

  assert.equal(body.style.position, 'fixed');
  assert.equal(body.style.top, '-185px');
  assert.equal(body.style.height, '75%');
  assert.equal(documentElement.style.height, '90%');
  assert.equal(properties.get('--zafiro-modal-viewport-height'), '730px');

  visualViewport.height = 310;
  visualViewport.dispatchEvent(new Event('resize'));
  visualViewport.offsetTop = 48;
  visualViewport.dispatchEvent(new Event('scroll'));
  assert.equal(properties.get('--zafiro-modal-viewport-height'), '310px');
  assert.equal(properties.get('--zafiro-modal-viewport-offset'), '48px');

  closeFirst();
  assert.equal(body.style.position, 'fixed');
  assert.equal(scrollCalls.length, 0);
  closeSecond();
  assert.equal(body.style.position, '');
  assert.equal(body.style.overflow, 'auto');
  assert.equal(properties.size, 0);
  assert.deepEqual(scrollCalls, [{ left: 0, top: 185, behavior: 'instant' }]);

  visualViewport.dispatchEvent(new Event('resize'));
  assert.equal(properties.size, 0);
});

test('when VisualViewport is unavailable the window height follows browser resize', () => {
  const { lock, properties, window } = loadScrollLock({ withVisualViewport: false });
  const close = lock();
  assert.equal(properties.get('--zafiro-modal-viewport-height'), '780px');

  window.innerHeight = 280;
  window.dispatchEvent(new Event('resize'));
  assert.equal(properties.get('--zafiro-modal-viewport-height'), '280px');
  assert.equal(properties.get('--zafiro-modal-viewport-offset'), '0px');
  close();
});
