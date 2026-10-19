const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPage, tweet, user, tick, source } = require('./helpers.cjs');

async function layoutPage(t) {
  const posts = [tweet('100'), tweet('101', '100'), tweet('102', '101'), tweet('103', '101')];
  posts[1].core.user_results.result = user('a_very_long_account_name', { rest_id: 'guest', core: {
    name: 'A very long display name that must truncate', screen_name: 'a_very_long_account_name'
  } });
  const p = createPage({ settings: { sidex_sub_reply_limit: 1, sidex_auto_load_replies: false },
    request: () => ({ data: posts.map(result => ({ tweet_results: { result } })) }) });
  t.after(() => p.w.close());
  const style = p.w.document.createElement('style'); style.textContent = source('sidebar.css');
  p.w.document.head.appendChild(style);
  await tick(); p.clickPost(0); await tick(); return p;
}

test('author metadata protects the time while names and handles can truncate', async t => {
  const p = await layoutPage(t);
  const item = p.query('[data-id="101"]');
  for (const selector of ['.sidepeek-time', '.sidepeek-more-col', '.sidepeek-dot']) {
    assert.equal(p.w.getComputedStyle(item.querySelector(selector)).flexShrink, '0', selector);
  }
  assert.equal(p.w.getComputedStyle(item.querySelector('.sidepeek-time')).whiteSpace, 'nowrap');
  assert.equal(p.w.getComputedStyle(item.querySelector('.sidepeek-author-meta')).flexGrow, '0');
  assert.equal(p.w.getComputedStyle(item.querySelector('.sidepeek-handle')).flexGrow, '0');
  assert.equal(p.w.getComputedStyle(item.querySelector('.sidepeek-more-col')).marginLeft, 'auto');
  for (const selector of ['.sidepeek-name', '.sidepeek-handle']) {
    const node = item.querySelector(selector), css = p.w.getComputedStyle(node);
    assert.equal(css.whiteSpace, 'nowrap'); assert.equal(css.textOverflow, 'ellipsis');
    assert.ok(node.title, 'truncated author information has a complete tooltip');
  }
});

test('action columns have count-independent sizing and nonshrinking icons', async t => {
  const p = await layoutPage(t), bar = p.query('.sidepeek-action-bar');
  const buttons = [...bar.children]; assert.equal(buttons.length, 6);
  assert.equal(p.w.getComputedStyle(bar).columnGap, '4px');
  assert.notEqual(p.w.getComputedStyle(bar).maxWidth, '400px');
  for (const b of buttons.slice(0, 4)) assert.equal(p.w.getComputedStyle(b).flexBasis, '0%');
  for (const b of buttons) {
    assert.equal(p.w.getComputedStyle(b).minHeight, '32px');
    assert.equal(p.w.getComputedStyle(b.querySelector('.sidepeek-action-btn-surface')).flexShrink, '0');
    const svg = p.w.getComputedStyle(b.querySelector('svg'));
    assert.equal(svg.width, '18.75px'); assert.equal(svg.height, '18.75px');
    assert.equal(svg.flexShrink, '0');
  }
  assert.equal(p.w.getComputedStyle(buttons[5]).marginLeft, '8px');
});

test('collapse shares the expansion row layout and restores the finite preview', async t => {
  const p = await layoutPage(t);
  p.query('.sidepeek-thread-group .sidepeek-expand-btn').click(); await tick();
  const button = p.query('.sidepeek-collapse-btn');
  assert.ok(button.parentElement.classList.contains('sidepeek-thread-continuation'));
  assert.equal(button.parentElement.children.length, 1, 'no separate spacer shifts the control');
  assert.equal(p.w.getComputedStyle(button).minHeight, '40px');
  assert.equal(p.w.getComputedStyle(button).paddingLeft, '64px');
  assert.match(button.textContent, /▲/);
  button.click(); await tick();
  assert.equal(p.w.document.querySelectorAll('.sidepeek-child-comment').length, 1);
  assert.equal(p.query('.sidepeek-collapse-btn'), null);
});

test('conversation rails have a separate color token in each supported theme', async t => {
  const p = await layoutPage(t), root = p.query('#sidepeek-drawer-root');
  for (const [theme, expected] of [['', '#cfd9de'], ['sidepeek-theme-dark', '#333639'], ['sidepeek-theme-dim', '#425364']]) {
    root.classList.remove('sidepeek-theme-dark', 'sidepeek-theme-dim');
    if (theme) root.classList.add(theme);
    const color = p.w.getComputedStyle(theme ? root : p.w.document.documentElement).getPropertyValue('--sp-thread-line').trim();
    assert.equal(color, expected);
  }
});
