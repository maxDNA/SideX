const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createPage, tweet, user, tick, source } = require('./helpers.cjs');

function post(id, parent = '', author = 'owner', text = `Post ${id}`, replies = 0) {
  const result = tweet(id, parent, text);
  result.core.user_results.result = user(author, { rest_id: author });
  result.legacy.conversation_id_str = '100';
  result.legacy.reply_count = replies;
  return result;
}
const entry = result => ({ content: { itemContent: { tweet_results: { result } } } });
function response(posts, cursor) {
  return { data: { instructions: [{ type: 'TimelineAddEntries', entries: [
    ...posts.map(entry), ...(cursor ? [{ content: { cursorType: 'Bottom', value: cursor } }] : [])
  ] }] } };
}
async function open(t, posts, settings = {}, request) {
  const p = createPage({ settings, request: request || (() => response(posts)) });
  t.after(() => p.w.close()); await tick(); p.clickPost(0); await tick(); return p;
}
function chain(length = 8, author = 'owner', start = 101, parent = '100') {
  return Array.from({ length }, (_, i) => post(String(start + i), i ? String(start + i - 1) : parent, author, `Continuation ${i}`, i < length - 1 ? 1 : 0));
}

for (const limit of [1, 2, 3, 5, 'all']) {
  test(`preview ${limit} fills missing data and applies the selected expansion limit`, async t => {
    const root = post('101', '100', 'guest', 'Root', 1);
    const p = await open(t, [], { sidex_sub_reply_limit: limit, sidex_auto_load_replies: false },
      m => m.tweetId === '100' ? response([post('100'), root])
        : response([root, ...chain(8, 'guest', 102, '101')]));
    await tick();
    assert.equal(p.w.document.querySelectorAll('.sidepeek-child-comment').length, limit === 'all' ? 8 : limit);
    assert.equal(p.calls.filter(m => m.tweetId === '101').length, 1);
    if (limit === 'all') assert.equal(p.query('.sidepeek-thread-group .sidepeek-expand-btn'), null);
    else assert.equal(p.query('.sidepeek-thread-group .sidepeek-expand-btn').textContent, `展开另外 ${8 - limit} 条已加载回复`);
  });
}

test('finite preview fills deep descendants for every group, including later outer pages', async t => {
  const roots = [101, 201, 301, 401].flatMap(id => [post(String(id), '100', 'guest', 'Root', 1), post(String(id + 1), String(id), 'guest', 'Child', 1)]);
  const p = await open(t, [], { sidex_sub_reply_limit: 3, sidex_auto_load_replies: false }, m => {
    if (m.cursor === 'outer') return response([post('501', '100', 'guest', 'Later root', 1), post('502', '501', 'guest', 'Child', 1)]);
    if (m.tweetId === '100') return response([post('100'), ...roots], 'outer');
    const id = Number(m.tweetId);
    return response([post(String(id), String(id - 1), 'guest', 'Child', 1), ...chain(5, 'guest', id + 1, String(id))]);
  });
  await tick();
  for (const group of p.w.document.querySelectorAll('.sidepeek-thread-group')) assert.equal(group.querySelectorAll('.sidepeek-child-comment').length, 3);
  assert.equal(p.calls.filter(m => m.tweetId !== '100').length, 4);
  p.query('.sidepeek-body > .sidepeek-pagination .sidepeek-load-more-btn').click(); await tick(); await tick();
  const later = p.query('[data-id="501"]').parentElement;
  assert.equal(later.querySelectorAll('.sidepeek-child-comment').length, 3);
  assert.equal(p.calls.filter(m => m.tweetId === '502').length, 1);
});

test('changing preview settings reapplies the finite cap after manual expansion', async t => {
  const p = await open(t, [post('100'), ...chain(8, 'guest')]);
  p.query('.sidepeek-thread-group .sidepeek-expand-btn').click(); await tick();
  p.change({ sidex_sub_reply_limit: { newValue: 'all' } }); await tick();
  for (const limit of [5, 3, 2, 1]) {
    p.change({ sidex_sub_reply_limit: { newValue: limit } }); await tick();
    assert.equal(p.w.document.querySelectorAll('.sidepeek-child-comment').length, limit);
  }
});

test('the focal author continuation is visible beyond the preview limit without extra requests', async t => {
  const p = await open(t, [post('100', '', 'owner', 'Main', 1), ...chain()]);
  for (let id = 101; id <= 108; id++) assert.ok(p.query(`[data-id="${id}"]`));
  assert.equal(p.query('.sidepeek-thread-group .sidepeek-expand-btn'), null);
  assert.equal(p.query('[data-id="107"] .sidepeek-act-reply span span').textContent, '1');
  assert.equal(p.calls.filter(m => m.type === 'READ_THREAD').length, 1);
});

test('non-author continuations and owner replies to other users remain preview-limited', async t => {
  const posts = [post('100', '', 'owner'), ...chain(4, 'other'), post('120', '104', 'owner', 'Owner answers somebody else', 1), post('121', '120', 'owner')];
  const p = await open(t, posts);
  assert.ok(p.query('[data-id="102"]'));
  assert.equal(p.query('[data-id="103"]'), null);
  assert.equal(p.query('[data-id="120"]'), null);
  const expand = p.query('.sidepeek-thread-group .sidepeek-expand-btn');
  assert.equal(expand.textContent, '展开另外 4 条已加载回复');
  expand.click(); await tick();
  assert.ok(p.query('[data-id="121"]'));
  assert.equal(p.calls.filter(m => m.type === 'READ_THREAD').length, 1, 'revealing loaded replies does not fetch');
});

test('mixed branches count only actually hidden loaded replies and keep author continuations visible', async t => {
  const p = await open(t, [post('100', '', 'owner'), ...chain(7), post('120', '101', 'guest', 'Branch A'), post('121', '120', 'guest', 'Branch B'), post('122', '121', 'owner', 'Owner answer')]);
  assert.ok(p.query('[data-id="107"]'));
  assert.ok(p.query('[data-id="120"]'));
  assert.equal(p.query('[data-id="121"]'), null);
  assert.equal(p.query('[data-id="122"]'), null);
  assert.equal(p.query('.sidepeek-thread-group .sidepeek-expand-btn').textContent, '展开另外 2 条已加载回复');
});

test('pagination extends the author chain while retaining manual text expansion', async t => {
  const long = 'Long continuation. '.repeat(40);
  const p = await open(t, [], {}, m => m.cursor ? response([post('103', '102'), post('104', '103')])
    : response([post('100'), post('101', '100', 'owner', long, 1), post('102', '101', 'owner', 'Second', 1)], 'next'));
  p.query('[data-id="101"] .sidepeek-show-more-btn').click();
  const item = p.query('[data-id="101"]');
  p.query('.sidepeek-body > .sidepeek-pagination .sidepeek-load-more-btn').click(); await tick();
  assert.ok(p.query('[data-id="104"]'));
  assert.equal(p.query('[data-id="101"]'), item);
  assert.equal(item.querySelector('.sidepeek-text').classList.contains('sidepeek-text-clamp'), false);
});

test('unknown child counts use an unnumbered fetch button rather than inventing hidden loaded replies', async t => {
  const p = await open(t, [post('100'), post('101', '100', 'guest', 'Reply', 20), post('102', '101', 'guest')]);
  const button = p.query('.sidepeek-fetch-replies-btn');
  assert.ok(button);
  assert.equal(button.textContent, '加载更多回复');
  assert.doesNotMatch(button.textContent, /20/);
});

test('unlimited preview shows every loaded depth and attempts to complete missing data', async t => {
  const posts = [post('100'), ...chain(8, 'guest'), post('120', '100', 'guest2', 'Unloaded branch', 20)];
  const p = await open(t, posts, { sidex_sub_reply_limit: 'all', sidex_auto_load_replies: false });
  const ids = () => [...p.w.document.querySelectorAll('.sidepeek-comment-item')].map(n => n.dataset.id);
  assert.deepEqual(ids(), ['101', '102', '103', '104', '105', '106', '107', '108', '120']);
  assert.equal(p.calls.filter(m => m.tweetId === '120').length, 1, 'unlimited preview attempts the missing branch');
  const body = p.query('.sidepeek-body'); body.scrollTop = 180;
  const textarea = p.query('.sidepeek-footer-textarea');
  textarea.value = 'Keep draft'; textarea.dispatchEvent(new p.w.Event('input', { bubbles: true }));
  p.change({ sidex_sub_reply_limit: { newValue: 1 } }); await tick();
  assert.deepEqual(ids(), ['101', '102', '120']);
  assert.equal(p.query('.sidepeek-thread-group .sidepeek-expand-btn').textContent, '展开另外 6 条已加载回复');
  assert.equal(p.calls.length, 2, 'the finite preview attempts to complete the missing child');
  p.change({ sidex_sub_reply_limit: { newValue: 'all' } }); await tick();
  assert.deepEqual(ids(), ['101', '102', '103', '104', '105', '106', '107', '108', '120']);
  assert.equal(p.query('.sidepeek-footer-textarea').value, 'Keep draft');
  assert.equal(body.scrollTop, 180);
  assert.equal(p.calls.length, 2, 'returning to unlimited does not repeat a completed request');
});

test('the popup persists unlimited preview, restores all supported options and localizes its meaning', t => {
  const prefs = { sidex_lang: 'zh' };
  const popup = () => {
    const dom = new JSDOM(source('popup.html'), { runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    dom.window.chrome = { storage: { sync: {
      get(defaults, cb) { cb({ ...defaults, ...prefs }); },
      set(values) { Object.assign(prefs, values); }
    } } };
    dom.window.eval(source('popup.js'));
    return dom.window.document;
  };
  const doc = popup();
  assert.equal(doc.querySelector('#sidex-limit-group .active').dataset.limit, '1');
  const all = doc.querySelector('[data-limit="all"]');
  assert.ok(all, 'the preview options include unlimited');
  assert.equal(all.textContent, '∞');
  all.click();
  assert.equal(prefs.sidex_sub_reply_limit, 'all');
  assert.equal(all.getAttribute('aria-pressed'), 'true');
  assert.match(all.getAttribute('title'), /自动补全/);
  doc.querySelector('[data-lang="en"]').click();
  assert.equal(all.getAttribute('aria-label'), 'Automatically expand all sub-replies');
  assert.match(all.getAttribute('title'), /automatically load/i);
  assert.equal(doc.querySelector('#txt-auto-load-desc').textContent, 'Load more when you reach the bottom');
  for (const value of ['all', 1, 2, 3, 5]) {
    prefs.sidex_sub_reply_limit = value;
    const restored = popup();
    assert.equal(restored.querySelector('#sidex-limit-group .active').dataset.limit, String(value));
  }
  doc.querySelector('[data-limit="3"]').click();
  assert.equal(prefs.sidex_sub_reply_limit, 3);
  assert.equal(all.getAttribute('aria-pressed'), 'false');
});

test('unlimited preview keeps folded and unavailable descendants protected', async t => {
  const blocked = { __typename: 'TweetWithVisibilityResults', tweet: post('104', '102', 'guest', 'UNAVAILABLE_BODY'),
    tweetInterstitial: { text: { text: 'Unavailable' } } };
  const posts = [post('100'), ...chain(3, 'guest'), blocked];
  const json = response(posts);
  json.data.instructions[0].entries.push(
    { content: { itemContent: { itemType: 'TimelineLabel', text: 'Probable spam' } } },
    entry(post('105', '102', 'guest', 'FOLDED_BODY')));
  const p = await open(t, [], { sidex_sub_reply_limit: 'all' }, () => json);
  assert.ok(p.query('[data-id="103"]'));
  assert.doesNotMatch(p.query('.sidepeek-body').textContent, /FOLDED_BODY|UNAVAILABLE_BODY/);
  p.query('.sidepeek-gated-btn').click(); await tick();
  assert.ok(p.query('[data-id="105"]'));
  assert.doesNotMatch(p.query('.sidepeek-body').textContent, /UNAVAILABLE_BODY/);
  assert.equal(p.calls.length, 1, 'revealing cached folded replies does not request more data');
});

test('unlimited preview keeps all loaded descendants visible beyond the fifth outer page and after setting changes', async t => {
  const pageCount = 8;
  const p = await open(t, [], { sidex_sub_reply_limit: 'all', sidex_auto_load_replies: false }, m => {
    assert.equal(m.tweetId, '100', 'unlimited display never fetches a child thread');
    const page = m.cursor ? Number(m.cursor.slice(5)) : 0;
    const root = 1001 + page * 100;
    return response([post('100'), post(String(root), '100', 'guest', 'Root', 1), ...chain(8, 'guest', root + 1, String(root))],
      page + 1 < pageCount ? `page-${page + 1}` : null);
  });
  const groups = () => [...p.w.document.querySelectorAll('.sidepeek-thread-group')];
  for (let page = 0; page < pageCount; page++) {
    assert.equal(groups().length, page + 1);
    for (const group of groups()) {
      assert.equal(group.querySelectorAll('.sidepeek-child-comment').length, 8);
      assert.equal(group.querySelector('.sidepeek-expand-btn'), null, 'no loaded descendants remain behind an expansion button');
    }
    if (page + 1 < pageCount) {
      p.query('.sidepeek-body > .sidepeek-pagination .sidepeek-load-more-btn').click(); await tick();
    }
  }
  assert.equal(p.calls.length, pageCount);
  p.change({ sidex_sub_reply_limit: { newValue: 5 } }); await tick();
  for (const group of groups()) assert.equal(group.querySelectorAll('.sidepeek-child-comment').length, 5);
  p.change({ sidex_sub_reply_limit: { newValue: 'all' } }); await tick();
  for (const group of groups()) assert.equal(group.querySelectorAll('.sidepeek-child-comment').length, 8);
  assert.equal(p.calls.length, pageCount, 'switching display settings adds no requests for already loaded descendants');
});

test('the default-off text option updates cached comments immediately and preserves manual expansion and drafts', async t => {
  const long = 'Long reply body. '.repeat(40);
  const p = await open(t, [post('100'), post('101', '100', 'guest', long), post('102', '100', 'guest2', long)]);
  const a = p.query('[data-id="101"]'), b = p.query('[data-id="102"]');
  assert.ok(a.querySelector('.sidepeek-text-clamp'));
  a.querySelector('.sidepeek-show-more-btn').click();
  const marker = p.w.document.createElement('span'); marker.textContent = 'Translator annotation';
  b.querySelector('.sidepeek-text').appendChild(marker);
  const textarea = p.query('.sidepeek-footer-textarea');
  textarea.focus(); textarea.value = 'Keep draft'; textarea.dispatchEvent(new p.w.Event('input', { bubbles: true }));
  const body = p.query('.sidepeek-body'); body.scrollTop = 250;
  const prefs = {};
  const popup = new JSDOM(source('popup.html'), { runScripts: 'outside-only' });
  t.after(() => popup.window.close());
  popup.window.chrome = { storage: { sync: {
    get(defaults, cb) { cb({ ...defaults, ...prefs, sidex_lang: 'zh' }); },
    set(values) { Object.assign(prefs, values); p.change(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { newValue: v }]))); }
  } } };
  popup.window.eval(source('popup.js'));
  const toggle = popup.window.document.querySelector('#sidex-auto-expand-text');
  assert.equal(toggle.checked, false);
  toggle.click(); await tick();
  assert.equal(prefs.sidex_auto_expand_reply_text, true);
  assert.equal(p.query('[data-id="102"]'), b);
  assert.equal(b.querySelector('.sidepeek-text-clamp'), null);
  assert.equal(b.querySelector('.sidepeek-show-more-btn'), null);
  assert.equal(marker.isConnected, true);
  toggle.click(); await tick();
  assert.equal(a.querySelector('.sidepeek-text-clamp'), null, 'manual expansion survives toggling the preference');
  assert.ok(b.querySelector('.sidepeek-text-clamp'));
  assert.equal(p.query('.sidepeek-footer-textarea').value, 'Keep draft');
  assert.equal(body.scrollTop, 250);
  popup.window.document.querySelector('[data-lang="en"]').click();
  assert.equal(popup.window.document.querySelector('#txt-auto-expand-title').textContent, 'Auto-expand reply text');
});

test('persisted auto-expand text never expands quoted cards or gated author replies', async t => {
  const root = post('100'); const reply = post('101', '100', 'owner', 'Long text. '.repeat(50));
  reply.quoted_status_result = { result: post('999', '', 'guest', 'Long quoted text. '.repeat(50)) };
  const hidden = post('102', '101', 'owner', 'GATED_AUTHOR_TEXT');
  const p = await open(t, [], { sidex_auto_expand_reply_text: true }, () => ({data:{instructions:[{type:'TimelineAddEntries',entries:[entry(root),entry(reply),{content:{itemContent:{itemType:'TimelineLabel',text:'Probable spam'}}},entry(hidden)]}]}}));
  assert.equal(p.query('[data-id="101"] .sidepeek-show-more-btn'), null);
  assert.equal(p.query('[data-id="102"]'), null);
  assert.doesNotMatch(p.query('.sidepeek-body').textContent, /GATED_AUTHOR_TEXT/);
  assert.ok(p.query('.sidepeek-gated-btn'));
  assert.equal(p.query('.sidepeek-quote-toggle').getAttribute('aria-expanded'), 'false', 'quoted cards retain their separate expansion state');
});
