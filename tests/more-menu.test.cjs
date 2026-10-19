const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPage, tick, source } = require('./helpers.cjs');

async function open(t, setupWindow) {
  const p = createPage({ setupWindow }); t.after(() => p.w.close());
  await tick(); p.clickPost(0); await tick();
  const style = p.w.document.createElement('style'); style.textContent = source('sidebar.css'); p.w.document.head.append(style);
  return p;
}
const button = p => p.query('[data-id="101"] .sidepeek-act-more');

test('more button has a visible fixed icon and a nonshrinking 32px target', async t => {
  const p = await open(t), b = button(p), css = p.w.getComputedStyle(b);
  assert.equal(css.width, '32px'); assert.equal(css.height, '32px'); assert.equal(css.flexShrink, '0');
  assert.equal(css.justifyContent, 'flex-end');
  const rules = [...p.w.document.styleSheets].flatMap(sheet => [...sheet.cssRules]);
  assert.equal(rules.filter(rule => rule.selectorText === '.sidepeek-act-more').at(-1).style.color, 'var(--sp-thread-line)');
  const icon = p.w.getComputedStyle(b.querySelector('svg'));
  assert.equal(icon.width, '18.75px'); assert.equal(icon.height, '18.75px');
  assert.equal([...p.w.document.styleSheets].flatMap(sheet => [...sheet.cssRules]).find(rule => rule.selectorText === '.sidepeek-act-more svg').style.fill.toLowerCase(), 'currentcolor');
  assert.equal(p.w.getComputedStyle(b.parentElement).marginRight, '0px');
  assert.equal(b.getAttribute('aria-haspopup'), 'menu'); assert.equal(b.getAttribute('aria-expanded'), 'false');
});

test('menu stays open across pointer exit and redraw, supports keyboard and toggles', async t => {
  const p = await open(t); button(p).click();
  const menu = p.query('.sidepeek-more-menu'); assert.ok(menu);
  menu.dispatchEvent(new p.w.MouseEvent('mouseleave')); assert.equal(p.query('.sidepeek-more-menu'), menu);
  p.change({ sidex_auto_expand_reply_text: { newValue: true } }); await tick();
  assert.equal(p.query('.sidepeek-more-menu'), menu, 'render-triggered scroll must not dismiss menu');
  assert.equal(button(p).getAttribute('aria-expanded'), 'true');
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  items[0].focus(); items[0].dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(p.w.document.activeElement, items[1]);
  items[1].dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(p.query('.sidepeek-more-menu'), null); assert.equal(p.w.document.activeElement, button(p));
  button(p).click(); button(p).click(); assert.equal(p.query('.sidepeek-more-menu'), null);
  button(p).click(); p.query('.sidepeek-body').dispatchEvent(new p.w.Event('scroll'));
  assert.equal(p.query('.sidepeek-more-menu'), null);
  button(p).click(); p.w.document.body.click(); assert.equal(p.query('.sidepeek-more-menu'), null);
  button(p).click();
  const other = p.query('[data-id="102"] .sidepeek-act-more');
  other.click();
  assert.equal(button(p).getAttribute('aria-expanded'), 'false');
  assert.equal(other.getAttribute('aria-expanded'), 'true');
  assert.equal(p.w.document.querySelectorAll('.sidepeek-more-menu').length, 1);
  p.w.dispatchEvent(new p.w.Event('resize'));
  assert.equal(p.query('.sidepeek-more-menu'), null);
});

test('custom menu measures its dimensions, flips above and avoids scrollbar bounds', async t => {
  const p = await open(t); const rect = (x, y, width, height) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height });
  p.query('.sidepeek-body').getBoundingClientRect = () => rect(500, 50, 350, 500);
  button(p).getBoundingClientRect = () => rect(798, 480, 32, 32);
  const original = p.w.HTMLElement.prototype.getBoundingClientRect;
  p.w.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.classList.contains('sidepeek-more-menu') ? rect(0, 0, 220, 220) : original.call(this);
  };
  const descriptor = Object.getOwnPropertyDescriptor(p.w.HTMLElement.prototype, 'offsetWidth');
  Object.defineProperty(p.w.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() {
    return this.classList.contains('sidepeek-more-menu') ? 240 : descriptor.get.call(this);
  } });
  button(p).click(); const menu = p.query('.sidepeek-more-menu');
  assert.equal(menu.style.left, '590px'); assert.equal(menu.style.top, '256px');
  assert.equal(menu.style.maxWidth, '322px');
});

test('menu operations remain bound to the selected reply and clipboard failures are handled', async t => {
  const copied = [], opened = [];
  const p = await open(t, w => {
    Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText: async value => copied.push(value) } });
    w.open = (...args) => opened.push(args);
  });
  button(p).click(); p.query('.sidepeek-menu-copy-link').click(); await tick();
  assert.match(copied[0], /\/status\/101$/);
  button(p).click(); p.query('.sidepeek-menu-copy-text').click(); await tick();
  assert.equal(copied[1], p.query('[data-id="101"] .sidepeek-text').textContent);
  button(p).click(); p.query('.sidepeek-menu-open-x').click(); assert.match(opened[0][0], /\/status\/101$/);
  for (const [selector, type] of [['.sidepeek-menu-mute', 'TOGGLE_MUTE'], ['.sidepeek-menu-block', 'TOGGLE_BLOCK']]) {
    button(p).click(); p.query(selector).click(); await tick();
    assert.equal(p.calls.at(-1).type, type); assert.equal(p.calls.at(-1).screenName, 'reader');
  }
  p.w.navigator.clipboard.writeText = async () => { throw new Error('denied'); };
  button(p).click(); p.query('.sidepeek-menu-copy-text').click(); await tick();
  assert.match(p.w.document.body.textContent, /复制失败|Copy failed/);
});

function signedIn(w, handle = 'reader') {
  const account = w.document.createElement('button');
  account.dataset.testid = 'SideNav_AccountSwitcher_Button';
  account.innerHTML = `<span>Current account</span><span>@${handle}</span>`;
  w.document.body.append(account);
}

test('own-post menu hides mute/block and cancelled deletion sends no request', async t => {
  const p = await open(t, w => { signedIn(w, 'ReAdEr'); w.confirm = () => false; });
  button(p).click();
  assert.ok(p.query('.sidepeek-menu-delete'));
  assert.equal(p.query('.sidepeek-menu-mute'), null); assert.equal(p.query('.sidepeek-menu-block'), null);
  p.query('.sidepeek-menu-delete').click(); await tick();
  assert.equal(p.calls.filter(m => m.type === 'DELETE_POST').length, 0);
  assert.ok(p.query('[data-id="101"]'));
});

test('post author status alone never grants a delete action', async t => {
  const p = await open(t, w => signedIn(w, 'someone_else'));
  button(p).click(); assert.equal(p.query('.sidepeek-menu-delete'), null);
  assert.ok(p.query('.sidepeek-menu-mute')); assert.ok(p.query('.sidepeek-menu-block'));
});

test('confirmed deletion waits for success and failed deletion preserves the post', async t => {
  const { thread } = require('./helpers.cjs');
  let finish;
  const p = createPage({ setupWindow(w) { signedIn(w); w.confirm = () => true; },
    request: m => m.type === 'DELETE_POST' ? new Promise((resolve, reject) => { finish = { resolve, reject }; }) : thread(m.tweetId) });
  t.after(() => p.w.close()); await tick(); p.clickPost(0); await tick();
  button(p).click(); p.query('.sidepeek-menu-delete').click(); await tick();
  assert.ok(p.query('[data-id="101"]'), 'no optimistic deletion');
  button(p).click(); assert.equal(p.query('.sidepeek-menu-delete').disabled, true);
  p.query('.sidepeek-more-menu').dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(p.calls.at(-1).tweetId, '101');
  finish.reject(new Error('not deleted')); await tick();
  assert.ok(p.query('[data-id="101"]'));
  button(p).click(); assert.equal(p.query('.sidepeek-menu-delete').disabled, false, 'retry enabled'); p.query('.sidepeek-menu-delete').click(); await tick();
  finish.resolve({ deletedTweetId: '101' }); await tick();
  assert.equal(p.query('[data-id="101"]'), null);
  assert.ok(p.query('[data-id="102"]'), 'other replies survive');
  p.query('.sidepeek-btn-close').click(); p.clickPost(0); await tick();
  assert.equal(p.query('[data-id="101"]'), null, 'stale responses do not restore deleted posts');
});
