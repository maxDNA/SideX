const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createPage, tweet, tick, source } = require('./helpers.cjs');

// Minimal public shape from JorWang/status/2111045574695047464:
// a conversation module has its own ShowMore despite outer Bottom termination.
const item = result => ({ entryId: `tweet-${result.rest_id}`, item: { itemContent: { tweet_results: { result } } } });
function moduleEntry(id, posts, cursor) {
  return { entryId: `conversationthread-${id}`, content: {
    entryType: 'TimelineTimelineModule', items: [...posts.map(item),
      ...(cursor ? [{ entryId: `cursor-${id}`, item: { itemContent: {
        itemType: 'TimelineTimelineCursor', cursorType: 'ShowMore', value: cursor,
        displayTreatment: { actionText: 'Show replies' }
      } } }] : [])]
  } };
}
const entry = result => ({ content: { itemContent: { tweet_results: { result } } } });
function detail(modules, { posts = [tweet('100', '99')], bottom, end = true } = {}) {
  return { data: { instructions: [{ type: 'TimelineAddEntries', entries: [
    ...posts.map(entry), ...modules,
    ...(bottom ? [{ content: { cursorType: 'Bottom', value: bottom } }] : [])
  ] }, ...(end ? [{ type: 'TimelineTerminateTimeline', direction: 'Bottom' }] : [])] } };
}
function initial(cursor = 'branch-next') {
  const parent = tweet('101', '100'); parent.legacy.reply_count = 1;
  return detail([moduleEntry('101', [parent, tweet('102', '101')], cursor)]);
}
async function open(t, request, settings = {}, setupWindow) {
  const p = createPage({ request, settings, setupWindow }); t.after(() => p.w.close());
  await tick(); p.clickPost(0); await tick(); return p;
}

function observeNative(p, json) {
  p.w.dispatchEvent(new p.w.MessageEvent('message', { source: p.w, origin: p.w.location.origin,
    data: { source: 'sidepeek-page', type: 'NATIVE_THREAD_OBSERVED',
      payload: { sidepeekObservedThreads: [{ requestTweetId: '100', json }] } } }));
}

for (const lang of ['zh', 'en']) {
  test(`internal and outer pagination use distinct loading labels in ${lang}`, async t => {
    let finishInner;
    const p = await open(t, m => m.cursor === 'inner' ? new Promise(resolve => { finishInner = resolve; })
      : m.cursor === 'outer' ? new Promise(() => {})
        : detail([moduleEntry('101', [tweet('101', '100'), tweet('102', '101')], 'inner')], { bottom: 'outer', end: false }),
      { sidex_lang: lang, sidex_auto_load_replies: false });
    assert.ok(p.query('.sidepeek-inline-load-more-btn').parentElement.classList.contains('sidepeek-thread-continuation'));
    assert.equal(p.query('.sidepeek-inline-load-more-btn').textContent, lang === 'zh' ? '显示更多回复' : 'Show more replies');
    assert.equal(p.query('.sidepeek-body > .sidepeek-pagination').classList.contains('sidepeek-thread-continuation'), false);
    p.query('.sidepeek-inline-load-more-btn').click(); await tick();
    assert.equal(p.query('.sidepeek-inline-load-more-btn').textContent, lang === 'zh' ? '正在加载回复...' : 'Loading replies...');
    finishInner(detail([moduleEntry('101', [tweet('103', '102')])], { posts: [] })); await tick();
    p.query('.sidepeek-body > .sidepeek-pagination .sidepeek-load-more-btn').click(); await tick();
    assert.equal(p.query('.sidepeek-body > .sidepeek-pagination .sidepeek-load-more-btn').textContent,
      lang === 'zh' ? '正在加载评论...' : 'Loading comments...');
  });
}

test('finite preview consumes an internal cursor only to fill the cap without expanding the group', async t => {
  const posts = Array.from({ length: 9 }, (_, i) => tweet(String(101 + i), String(100 + i)));
  for (const p of posts) p.core.user_results.result.rest_id = 'guest';
  const p = await open(t, m => m.cursor ? detail([moduleEntry('101', posts.slice(2), 'remaining')])
    : detail([moduleEntry('101', posts.slice(0, 2), 'first')]), { sidex_sub_reply_limit: 5, sidex_auto_load_replies: false });
  await tick();
  assert.deepEqual(p.calls.filter(m => m.cursor).map(m => m.cursor), ['first']);
  assert.equal(p.w.document.querySelectorAll('.sidepeek-child-comment').length, 5);
  assert.equal(p.query('.sidepeek-thread-group .sidepeek-expand-btn').textContent, '展开 3 条回复');
});

test('finite preview follows several pages and stops once the selected count is loaded', async t => {
  const posts = Array.from({ length: 7 }, (_, i) => tweet(String(101 + i), String(100 + i)));
  for (const p of posts) p.core.user_results.result.rest_id = 'guest';
  const p = await open(t, m => m.cursor === 'a' ? detail([moduleEntry('101', posts.slice(2, 4), 'b')])
    : m.cursor === 'b' ? detail([moduleEntry('101', posts.slice(4, 6), 'c')])
      : detail([moduleEntry('101', posts.slice(0, 2), 'a')]), { sidex_sub_reply_limit: 5 });
  await tick();
  assert.deepEqual(p.calls.filter(m => m.cursor).map(m => m.cursor), ['a', 'b']);
  assert.equal(p.w.document.querySelectorAll('.sidepeek-child-comment').length, 5);
  assert.ok(p.query('.sidepeek-inline-load-more-btn'), 'remaining data stays manual after the cap');
});

test('unlimited preview automatically follows every internal page independently of outer auto-loading', async t => {
  const posts = Array.from({ length: 10 }, (_, i) => tweet(String(101 + i), String(100 + i)));
  for (const post of posts) post.core.user_results.result.rest_id = 'guest';
  const p = await open(t, m => !m.cursor ? detail([moduleEntry('101', posts.slice(0, 2), 'a')])
    : m.cursor === 'a' ? detail([moduleEntry('101', posts.slice(2, 5), 'b')])
      : detail([moduleEntry('101', posts.slice(5))]), { sidex_sub_reply_limit: 'all', sidex_auto_load_replies: false });
  await tick(); await tick();
  assert.deepEqual(p.calls.filter(m => m.cursor).map(m => m.cursor), ['a', 'b']);
  assert.equal(p.w.document.querySelectorAll('.sidepeek-child-comment').length, 9);
  assert.equal(p.query('.sidepeek-inline-load-more-btn'), null);
  p.change({ sidex_sub_reply_limit: { newValue: 3 } }); await tick();
  assert.equal(p.w.document.querySelectorAll('.sidepeek-child-comment').length, 3);
  assert.equal(p.calls.length, 3);
});

test('switching from unlimited to a finite cap stops further internal pages after an in-flight response', async t => {
  let finish;
  const posts = [tweet('101', '100'), tweet('102', '101')];
  for (const post of posts) post.core.user_results.result.rest_id = 'guest';
  const p = await open(t, m => m.cursor ? new Promise(resolve => { finish = resolve; })
    : detail([moduleEntry('101', posts, 'a')]), { sidex_sub_reply_limit: 'all' });
  assert.equal(typeof finish, 'function');
  p.change({ sidex_sub_reply_limit: { newValue: 1 } }); await tick();
  finish(detail([moduleEntry('101', [tweet('103', '102')], 'b')])); await tick(); await tick();
  assert.equal(p.w.document.querySelectorAll('.sidepeek-child-comment').length, 1);
  assert.deepEqual(p.calls.filter(m => m.cursor).map(m => m.cursor), ['a']);
});

for (const limit of [5, 'all']) for (const outcome of ['error', 'empty', 'cycle']) {
  test(`preview ${limit} stops on ${outcome} instead of repeatedly requesting internal data`, async t => {
    const posts = [tweet('101', '100'), tweet('102', '101')];
    for (const post of posts) post.core.user_results.result.rest_id = 'guest';
    const p = await open(t, m => {
      if (!m.cursor) return detail([moduleEntry('101', posts, 'a')]);
      if (outcome === 'error') throw new Error('offline');
      return detail([moduleEntry('101', [], outcome === 'cycle' ? 'a' : 'b')]);
    }, { sidex_sub_reply_limit: limit });
    await tick(); await tick();
    assert.equal(p.calls.filter(m => m.cursor).length, 1);
    assert.equal(p.w.document.querySelectorAll('.sidepeek-child-comment').length, 1);
    assert.ok(p.query(outcome === 'error' ? '.sidepeek-pagination-error' : '.sidepeek-pagination-paused'));
    p.change({ sidex_lang: { newValue: 'en' } }); await tick();
    assert.equal(p.calls.filter(m => m.cursor).length, 1, 'rerendering does not resume a stopped page');
  });
}

test('changing the preview cap while a manual load is pending prevents a stale full expansion', async t => {
  let finish;
  const posts = Array.from({ length: 9 }, (_, i) => tweet(String(101 + i), String(100 + i)));
  for (const p of posts) p.core.user_results.result.rest_id = 'guest';
  const p = await open(t, m => m.cursor ? new Promise(resolve => { finish = resolve; })
    : detail([moduleEntry('101', posts.slice(0, 6), 'a')]), { sidex_sub_reply_limit: 5 });
  p.query('.sidepeek-inline-load-more-btn').click(); await tick();
  p.change({ sidex_sub_reply_limit: { newValue: 1 } }); await tick();
  finish(detail([moduleEntry('101', posts.slice(6))])); await tick();
  assert.equal(p.w.document.querySelectorAll('.sidepeek-child-comment').length, 1);
  assert.equal(p.calls.filter(m => m.cursor).length, 1);
});

test('switching to unlimited during finite completion continues subsequent pages', async t => {
  let finish;
  const posts = [tweet('101', '100'), tweet('102', '101')];
  for (const post of posts) post.core.user_results.result.rest_id = 'guest';
  const p = await open(t, m => m.cursor === 'a' ? new Promise(resolve => { finish = resolve; })
    : m.cursor === 'b' ? detail([moduleEntry('101', [tweet('104', '103')])])
    : detail([moduleEntry('101', posts, 'a')]), { sidex_sub_reply_limit: 5 });
  p.change({ sidex_sub_reply_limit: { newValue: 'all' } }); await tick();
  finish(detail([moduleEntry('101', [tweet('103', '102')], 'b')])); await tick(); await tick();
  assert.ok(p.query('[data-id="103"]'));
  assert.equal(p.calls.filter(m => m.cursor).length, 2);
  assert.ok(p.query('[data-id="104"]'));
  assert.equal(p.query('.sidepeek-inline-load-more-btn'), null);
});

test('switching to a reply and returning preserves the current response order and cached descendants', async t => {
  let visitedChild = false;
  const current = detail([], { posts: [tweet('100'), tweet('101', '100', 'CURRENT_A'),
    tweet('102', '100'), tweet('103', '100')] });
  const child = detail([], { posts: [tweet('100'), tweet('103', '100'), tweet('104', '103')] });
  const p = await open(t, m => {
    if (m.tweetId === '103') { visitedChild = true; return child; }
    return visitedChild ? { ...current, sidepeekObservedThreads: [{ requestTweetId: '103', json: child }] } : current;
  }, { sidex_auto_load_replies: false }, w => {
    w.document.querySelector('a[href="/reader/status/200"]').href = '/reader/status/103';
  });
  const roots = () => [...p.w.document.querySelectorAll('.sidepeek-comment-item:not(.sidepeek-child-comment)')]
    .map(node => node.dataset.id);
  assert.deepEqual(roots(), ['101', '102', '103']);
  p.clickPost(1); await tick();
  assert.ok(p.query('[data-id="104"]'));
  p.clickPost(0); await tick();
  assert.deepEqual(roots(), ['101', '102', '103']);
  assert.ok(p.query('[data-id="104"]'), 'the cached descendant is retained after returning');
  assert.equal(p.w.document.querySelectorAll('[data-id="103"]').length, 1);
});

test('current response order and model updates win over multiple cached reply visits', t => {
  const dom = new JSDOM('', { runScripts: 'outside-only' }); t.after(() => dom.window.close());
  dom.window.eval(source('core.js'));
  const json = detail([], { posts: [tweet('100'), tweet('101', '100'),
    tweet('102', '100', 'CURRENT_B'), tweet('103', '100')] });
  json.sidepeekObservedThreads = [
    { requestTweetId: '103', json: detail([], { posts: [tweet('100'), tweet('103', '100'), tweet('104', '103')] }) },
    { requestTweetId: '102', json: detail([], { posts: [tweet('100'), tweet('102', '100', 'STALE_B')] }) }
  ];
  const core = dom.window.SidePeekCore;
  const parsed = core.parseTweetDetail(json, '100');
  assert.deepEqual(Array.from(core.buildConversationTree(parsed.replies, '100').rootReplies, r => r.id), ['101', '102', '103']);
  assert.equal(parsed.replies.find(r => r.id === '102').text, 'CURRENT_B');
  assert.deepEqual(Array.from(parsed.replies, r => r.id), ['101', '102', '103', '104']);
});

test('an observation-only update retains cached reply order when the current response has no models', t => {
  const dom = new JSDOM('', { runScripts: 'outside-only' }); t.after(() => dom.window.close());
  dom.window.eval(source('core.js'));
  const parsed = dom.window.SidePeekCore.parseTweetDetail({ data: {}, sidepeekObservedThreads: [
    { requestTweetId: '100', json: detail([], { posts: [tweet('100'), tweet('103', '100'), tweet('101', '100')] }) }
  ] }, '100');
  assert.deepEqual(Array.from(parsed.replies, r => r.id), ['103', '101']);
});

test('late native observations cannot restore a completed inline continuation', async t => {
  const p = await open(t, m => m.cursor
    ? detail([moduleEntry('101', [tweet('103', '102'), tweet('104', '103')])], { posts: [] })
    : initial(), { sidex_auto_load_replies: false });
  p.query('.sidepeek-inline-load-more-btn').click(); await tick();
  assert.ok(p.query('[data-id="104"]'));
  assert.ok(p.query('.sidepeek-collapse-btn'));
  assert.equal(p.query('.sidepeek-inline-load-more-btn'), null);
  observeNative(p, initial()); await tick();
  assert.equal(p.query('.sidepeek-inline-load-more-btn'), null, 'an older response must not resurrect the consumed cursor');
  assert.ok(p.query('.sidepeek-collapse-btn'));
  assert.equal(p.calls.filter(m => m.cursor).length, 1);
  const fresh = initial('genuinely-new');
  observeNative(p, fresh); await tick();
  assert.ok(p.query('.sidepeek-inline-load-more-btn'), 'a new continuation remains available');
  observeNative(p, initial()); await tick();
  p.query('.sidepeek-inline-load-more-btn').click(); await tick();
  assert.equal(p.calls.filter(m => m.cursor).at(-1).cursor, 'genuinely-new', 'older observations cannot roll back a newer cursor');
  p.clickPost(1); await tick(); p.clickPost(0); await tick();
  assert.ok(p.query('.sidepeek-inline-load-more-btn'), 'opening a new thread session resets the consumed history');
});

test('a native module completion also prevents replaying its old continuation', async t => {
  const p = await open(t, () => initial(), { sidex_auto_load_replies: false });
  observeNative(p, detail([moduleEntry('101', [tweet('101', '100'), tweet('102', '101'), tweet('103', '102')])]));
  await tick();
  assert.equal(p.query('.sidepeek-inline-load-more-btn'), null);
  observeNative(p, initial()); await tick();
  assert.equal(p.query('.sidepeek-inline-load-more-btn'), null);
  assert.equal(p.calls.filter(m => m.cursor).length, 0, 'completion does not require a redundant request');
});

for (const addsReply of [false, true]) {
  test('native observations preserve an in-flight inline request, with a new reply ' + addsReply, async t => {
    let finish;
    const p = await open(t, m => m.cursor ? new Promise(resolve => { finish = resolve; }) : initial(),
      { sidex_auto_load_replies: false });
    const editor = p.query('.sidepeek-footer-textarea'); editor.value = 'Keep this reply';
    editor.dispatchEvent(new p.w.Event('input', { bubbles: true }));
    p.query('.sidepeek-inline-load-more-btn').click(); await tick();
    const observed = initial();
    if (addsReply) observed.data.instructions[0].entries.push(entry(tweet('110', '100')));
    observeNative(p, observed); await tick();
    assert.equal(p.query('.sidepeek-inline-load-more-btn').disabled, true, 'the same cursor is still being loaded');
    p.query('.sidepeek-inline-load-more-btn').click(); await tick();
    assert.equal(p.calls.filter(m => m.cursor).length, 1);
    finish(detail([moduleEntry('101', [tweet('103', '102')])], { posts: [] })); await tick();
    assert.ok(p.query('[data-id="103"]'), 'the original successful response is accepted');
    assert.equal(p.query('.sidepeek-inline-load-more-btn'), null);
    assert.equal(p.query('.sidepeek-footer-textarea').value, 'Keep this reply');
    if (addsReply) assert.ok(p.query('[data-id="110"]'));
  });
}

test('native visibility updates reclassify existing replies and hide their cached descendants', async t => {
  const p = await open(t, () => initial(null));
  assert.ok(p.query('[data-id="101"]')); assert.ok(p.query('[data-id="102"]'));
  const editor = p.query('.sidepeek-footer-textarea'); editor.value = 'Keep draft';
  editor.dispatchEvent(new p.w.Event('input', { bubbles: true }));
  const folded = detail([]);
  folded.data.instructions[0].entries.push(
    { content: { itemContent: { itemType: 'TimelineLabel', text: 'Probable spam' } } },
    entry(tweet('101', '100', 'UPDATED_FOLDED_REPLY')));
  observeNative(p, folded); await tick();
  assert.equal(p.query('[data-id="101"]'), null);
  assert.equal(p.query('[data-id="102"]'), null, 'cached descendants inherit the folded parent boundary');
  assert.ok(p.query('.sidepeek-gated-btn'));
  observeNative(p, detail([], { posts: [tweet('100'), tweet('101', '100', 'UPDATED_NORMAL_REPLY')] })); await tick();
  assert.match(p.query('[data-id="101"]').textContent, /UPDATED_NORMAL_REPLY/);
  assert.ok(p.query('[data-id="102"]'));
  assert.equal(p.query('.sidepeek-section-label'), null);
  assert.equal(p.query('.sidepeek-gated-btn'), null);
  observeNative(p, folded); await tick();
  p.query('.sidepeek-gated-btn').click(); await tick();
  assert.match(p.query('[data-id="101"]').textContent, /UPDATED_FOLDED_REPLY/);
  assert.ok(p.query('[data-id="102"]'));
  assert.equal(p.query('.sidepeek-section-label').textContent, 'Probable spam');
  assert.equal(p.query('.sidepeek-footer-textarea').value, 'Keep draft');
});

test('native unavailability hides an existing reply and its descendants until a valid update arrives', async t => {
  const p = await open(t, () => initial(null));
  const unavailable = detail([]);
  unavailable.data.instructions[0].entries.push({ entryId: 'tweet-101',
    content: { itemContent: { tweet_results: { result: { __typename: 'TweetUnavailable' } } } } });
  observeNative(p, unavailable); await tick();
  assert.equal(p.query('[data-id="101"]'), null);
  assert.equal(p.query('[data-id="102"]'), null);
  observeNative(p, detail([], { posts: [tweet('100'), tweet('101', '100')] })); await tick();
  assert.ok(p.query('[data-id="101"]'));
  assert.ok(p.query('[data-id="102"]'));
});

test('an ended outer timeline retains a separately scoped inline continuation', t => {
  const dom = new JSDOM('', { runScripts: 'outside-only' }); t.after(() => dom.window.close());
  dom.window.eval(source('core.js'));
  const result = dom.window.SidePeekCore.parseTweetDetail(initial(), '100');
  assert.equal(result.cursor, null);
  assert.equal(result.pagination.ended, true);
  assert.equal(result.pagination.inlineCursors.length, 1);
  assert.equal(result.pagination.inlineCursors[0].branchRootId, '101');
  assert.equal(result.pagination.inlineCursors[0].requestTweetId, '100');
});

test('a known inline cursor replaces speculative count-based fetching', async t => {
  const json = initial();
  json.data.instructions[0].entries[1].content.items[0].item.itemContent.tweet_results.result.legacy.reply_count = 10;
  const p = await open(t, () => json);
  assert.ok(p.query('.sidepeek-inline-load-more-btn'));
  assert.equal(p.query('.sidepeek-fetch-replies-btn'), null);
});

test('a child request with zero reported replies still includes native-observed descendants', async t => {
  const native = detail([moduleEntry('101', [tweet('101', '100'), tweet('102', '101'),
    tweet('103', '102'), tweet('104', '103')])]);
  const p = await open(t, m => {
    if (m.tweetId === '200') return detail([], { posts: [tweet('200')] });
    // This is the actual failing shape: focal 100, a single child 101, no
    // ShowMore, Bottom terminated; native X has already loaded 102..104.
    const json = detail([moduleEntry('101', [tweet('101', '100')])]);
    json.sidepeekObservedThreads = [{ requestTweetId: '99', json: native }];
    return json;
  });
  assert.ok(p.query('[data-id="104"]'), 'native descendants must not disappear');
  assert.equal(p.query('.sidepeek-count-badge').textContent, '(1/0)');
});

test('native observations arriving after the child panel opens restore only its descendants', async t => {
  const p = await open(t, () => detail([moduleEntry('101', [tweet('101', '100')])]));
  const native = detail([moduleEntry('101', [tweet('101', '100'), tweet('102', '101'), tweet('103', '102')]),
    moduleEntry('200', [tweet('200', '99')])]);
  p.w.dispatchEvent(new p.w.MessageEvent('message', { source: p.w, origin: p.w.location.origin,
    data: { source: 'sidepeek-page', type: 'NATIVE_THREAD_OBSERVED',
      payload: { sidepeekObservedThreads: [{ requestTweetId: '99', json: native }] } } }));
  await tick();
  assert.ok(p.query('[data-id="103"]'));
  assert.equal(p.query('[data-id="200"]'), null);
});

test('replaying a consumed native module cursor never rebinds it to a child request', t => {
  const dom = new JSDOM('', { runScripts: 'outside-only' }); t.after(() => dom.window.close());
  dom.window.eval(source('core.js'));
  const json = detail([moduleEntry('102', [tweet('102', '101')])], { posts: [tweet('101', '100')] });
  json.sidepeekObservedThreads = [
    { requestTweetId: '100', json: initial('native-next') },
    { requestTweetId: '100', cursor: 'native-next', json: { data: { instructions: [{
      type: 'TimelineAddToModule', moduleEntryId: 'conversationthread-101',
      moduleItems: [item(tweet('103', '102')), item(tweet('104', '103'))]
    }] } } }
  ];
  const parsed = dom.window.SidePeekCore.parseTweetDetail(json, '101');
  assert.deepEqual(Array.from(parsed.replies, r => r.id), ['102', '103', '104']);
  assert.equal(parsed.pagination.inlineCursors.length, 0);
});

test('native cached folded bodies never become normal visible replies', async t => {
  const native = initial();
  native.data.instructions[0].entries.splice(1, 0, { content: { itemContent: { itemType: 'TimelineLabel', text: 'Probable spam' } } });
  native.data.instructions[0].entries[2] = moduleEntry('101', [tweet('101', '100'), tweet('102', '101', 'FOLDED_BODY')]);
  const p = await open(t, () => {
    const json = detail([], { posts: [tweet('100')] });
    json.sidepeekObservedThreads = [{ requestTweetId: '99', json: native }];
    return json;
  });
  assert.doesNotMatch(p.query('.sidepeek-body').textContent, /FOLDED_BODY/);
  p.query('.sidepeek-gated-btn').click(); await tick();
  assert.match(p.query('.sidepeek-body').textContent, /FOLDED_BODY/);
});

test('a module-local folded boundary also protects its continuation', async t => {
  const native = initial();
  native.data.instructions[0].entries[1].content.items.splice(1, 0,
    { item: { itemContent: { itemType: 'TimelineLabel', text: 'Probable spam' } } });
  const p = await open(t, () => {
    const json = detail([], { posts: [tweet('100')] });
    json.sidepeekObservedThreads = [{ requestTweetId: '99', json: native }];
    return json;
  });
  assert.ok(p.query('[data-id="101"]'));
  assert.equal(p.query('[data-id="102"]'), null);
  assert.equal(p.query('.sidepeek-inline-load-more-btn'), null);
});

test('a live visibility restriction overrides an older cached body', t => {
  const dom = new JSDOM('', { runScripts: 'outside-only' }); t.after(() => dom.window.close());
  dom.window.eval(source('core.js'));
  const json = detail([moduleEntry('101', [tweet('101', '100')])]);
  json.data.instructions[0].entries.push({ content: { itemContent: { tweet_results: { result: {
    __typename: 'TweetWithVisibilityResults', tweet: tweet('102', '101', 'RESTRICTED_BODY'),
    tweetInterstitial: { text: { text: 'Unavailable' } }
  } } } } });
  json.sidepeekObservedThreads = [{ requestTweetId: '100', json: detail([moduleEntry('101', [tweet('101', '100'), tweet('102', '101', 'RESTRICTED_BODY')])]) }];
  const parsed = dom.window.SidePeekCore.parseTweetDetail(json, '100');
  assert.deepEqual(Array.from(parsed.replies, p => p.id), ['101']);
  json.data.instructions[0].entries.at(-1).entryId = 'tweet-102';
  json.data.instructions[0].entries.at(-1).content.itemContent.tweet_results.result = { __typename: 'TweetUnavailable' };
  const tombstone = dom.window.SidePeekCore.parseTweetDetail(json, '100');
  assert.deepEqual(Array.from(tombstone.replies, p => p.id), ['101']);
});

test('related and sibling module cursors cannot enter a nested focal scope', t => {
  const dom = new JSDOM('', { runScripts: 'outside-only' }); t.after(() => dom.window.close());
  dom.window.eval(source('core.js'));
  const json = initial();
  const sibling = tweet('110', '99'); sibling.legacy.conversation_id_str = '99';
  json.data.instructions[0].entries.push(moduleEntry('110', [sibling], 'sibling'));
  const related = moduleEntry('120', [tweet('120', '100')], 'related');
  related.entryId = 'tweetdetailrelatedtweets-120';
  json.data.instructions[0].entries.push(related);
  const result = dom.window.SidePeekCore.parseTweetDetail(json, '100');
  assert.deepEqual(Array.from(result.pagination.inlineCursors, c => c.cursor), ['branch-next']);
});

test('the missing replies load via the original request scope without changing the direct count', async t => {
  const p = await open(t, m => m.cursor ? detail([moduleEntry('101', [tweet('103', '101'), tweet('104', '103')])], { posts: [] })
    : initial(), { sidex_auto_load_replies: false });
  assert.equal(p.query('.sidepeek-pagination-end'), null);
  const button = p.query('.sidepeek-inline-load-more-btn'); assert.ok(button);
  button.click(); await tick();
  assert.equal(p.calls.at(-1).tweetId, '100');
  assert.equal(p.calls.at(-1).cursor, 'branch-next');
  assert.ok(p.query('[data-id="103"]'));
  assert.ok(p.query('[data-id="104"]'));
  assert.equal(p.query('.sidepeek-count-badge').textContent, '(1/0)');
  assert.equal(p.query('.sidepeek-inline-load-more-btn'), null);
  assert.equal(p.w.document.querySelectorAll('.sidepeek-pagination-end').length, 1);
});

test('module append responses preserve other branches and outer pagination', async t => {
  const p = await open(t, m => m.cursor ? { data: { instructions: [{ type: 'TimelineAddToModule',
    moduleEntryId: 'conversationthread-101', moduleItems: [item(tweet('103', '102'))] }] } }
    : detail([moduleEntry('101', [tweet('101', '100'), tweet('102', '101')], 'a'),
      moduleEntry('110', [tweet('110', '100'), tweet('111', '110')], 'b')], { bottom: 'outer', end: false }), { sidex_sub_reply_limit: 1 });
  assert.equal(p.w.document.querySelectorAll('.sidepeek-inline-load-more-btn').length, 2);
  p.query('.sidepeek-inline-load-more-btn').click(); await tick();
  assert.ok(p.query('[data-id="103"]'));
  assert.equal(p.w.document.querySelectorAll('.sidepeek-inline-load-more-btn').length, 1);
  assert.ok(p.query('.sidepeek-body > .sidepeek-pagination .sidepeek-load-more-btn'));
  p.query('.sidepeek-inline-load-more-btn').click(); await tick();
  assert.equal(p.calls.at(-1).cursor, 'b');
});

test('inline cursor cycles stop, and empty changed pages require manual continuation', async t => {
  const p = await open(t, m => m.cursor ? detail([moduleEntry('101', [], m.cursor === 'a' ? 'b' : 'a')], { posts: [] })
    : initial('a'));
  p.query('.sidepeek-inline-load-more-btn').click(); await tick();
  assert.ok(p.query('.sidepeek-inline-pagination .sidepeek-pagination-paused'));
  assert.equal(p.query('.sidepeek-inline-load-more-btn').disabled, false);
  p.query('.sidepeek-inline-load-more-btn').click(); await tick();
  assert.equal(p.query('.sidepeek-inline-load-more-btn').disabled, true);
  assert.equal(p.query('.sidepeek-pagination-end'), null);
  assert.equal(p.calls.length, 3);
});

test('a failed inline request retries the same cursor and preserves loaded nodes and drafts', async t => {
  let fail = true;
  const p = await open(t, m => {
    if (!m.cursor) return initial();
    if (fail) throw new Error('offline');
    return detail([moduleEntry('101', [tweet('103', '102')])], { posts: [] });
  });
  const node = p.query('[data-id="102"]');
  const body = p.query('.sidepeek-body'); body.scrollTop = 170;
  const text = p.query('.sidepeek-footer-textarea'); text.value = 'Keep draft';
  text.dispatchEvent(new p.w.Event('input', { bubbles: true }));
  p.query('.sidepeek-inline-load-more-btn').click(); await tick();
  assert.ok(p.query('.sidepeek-inline-pagination .sidepeek-pagination-error'));
  fail = false; p.query('.sidepeek-inline-load-more-btn').click(); await tick();
  assert.equal(p.calls.at(-1).cursor, 'branch-next');
  assert.equal(p.query('[data-id="102"]'), node);
  assert.equal(p.query('.sidepeek-footer-textarea').value, 'Keep draft');
  assert.equal(body.scrollTop, 170);
});

function observers() {
  const all = [];
  return { setup(w) { w.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.targets = []; all.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.targets = []; }
  }; }, fire() { for (const observer of [...all]) {
    observer.callback(observer.targets.filter(t => t.isConnected).map(target => ({ target, isIntersecting: true })));
  } }, all };
}

test('internal continuations stay manual and reopening restores the finite preview', async t => {
  const io = observers();
  const parent = tweet('101', '100');
  parent.core.user_results.result.rest_id = 'guest';
  const current = detail([moduleEntry('101', [parent, tweet('102', '101')], 'branch-next')]);
  const continuation = detail([moduleEntry('101', [tweet('103', '102')])], { posts: [] });
  let loaded = false;
  const p = createPage({ settings: { sidex_sub_reply_limit: 1, sidex_auto_load_replies: true },
    setupWindow(w) { io.setup(w); w.history.replaceState({}, '', '/reader/status/100'); },
    request: m => {
      if (m.cursor) { loaded = true; return continuation; }
      return loaded ? { ...current, sidepeekObservedThreads: [
        { requestTweetId: '100', cursor: 'branch-next', json: continuation }
      ] } : current;
    } });
  t.after(() => p.w.close()); await tick();
  const shown = () => [...p.w.document.querySelectorAll('.sidepeek-thread-group .sidepeek-comment-item')].map(n => n.dataset.id);
  assert.deepEqual(shown(), ['101', '102']);
  io.fire(); await tick();
  assert.equal(p.calls.filter(m => m.cursor).length, 0, 'internal continuations never load on intersection');
  p.query('.sidepeek-inline-load-more-btn').click(); await tick();
  assert.deepEqual(shown(), ['101', '102', '103']);
  p.query('.sidepeek-btn-close').click(); p.clickPost(0); await tick();
  assert.deepEqual(shown(), ['101', '102']);
  assert.equal(p.query('.sidepeek-thread-group .sidepeek-expand-btn').textContent, '展开 1 条回复');
  io.fire(); await tick();
  assert.equal(p.calls.filter(m => m.cursor).length, 1, 'reopening retains the cache without automatically fetching it again');
});

test('only outer pages load automatically, remain single-flight and respond immediately to the preference', async t => {
  const io = observers(); let resolve;
  const p = await open(t, m => m.cursor ? new Promise(r => { resolve = r; })
    : detail([moduleEntry('101', [tweet('101', '100'), tweet('102', '101')], 'a')], { bottom: 'outer', end: false }),
    { sidex_auto_load_replies: false }, io.setup);
  io.fire(); await tick(); assert.equal(p.calls.length, 1);
  p.change({ sidex_auto_load_replies: { newValue: true } }); await tick();
  io.fire(); io.fire(); await tick(); assert.equal(p.calls.length, 2);
  assert.equal(p.calls[1].cursor, 'outer', 'the visible inline cursor is not consumed automatically');
  p.change({ sidex_auto_load_replies: { newValue: false } });
  resolve(detail([], { posts: [] })); await tick();
  io.fire(); await tick(); assert.equal(p.calls.length, 2);
  // Finishing the outer page must preserve its outstanding module cursor.
  assert.ok(p.query('.sidepeek-inline-load-more-btn'));
  assert.equal(p.query('.sidepeek-pagination-end'), null);
});

test('manual inline loading ignores responses arriving after switching posts', async t => {
  const io = observers(); let resolve;
  const p = await open(t, m => m.cursor ? new Promise(r => { resolve = r; })
    : m.tweetId === '200' ? detail([], { posts: [tweet('200')] }) : initial(), {}, io.setup);
  io.fire(); await tick();
  assert.equal(p.calls.length, 1);
  p.query('.sidepeek-inline-load-more-btn').click(); await tick();
  p.clickPost(1); await tick();
  resolve(detail([moduleEntry('101', [tweet('103', '102')])], { posts: [] })); await tick();
  assert.equal(p.query('[data-id="103"]'), null);
  assert.equal(p.query('.sidepeek-inline-load-more-btn'), null);
  assert.equal(p.calls.filter(m => m.cursor).length, 1);
});

test('a folded preview must be expanded before its manual inline continuation is offered', async t => {
  const io = observers();
  const posts = [tweet('101', '100'), tweet('102', '101'), tweet('103', '102')];
  for (const post of posts) post.core.user_results.result.rest_id = 'other-author';
  const p = await open(t, () => detail([moduleEntry('101', posts, 'a')]), {}, io.setup);
  assert.equal(p.query('.sidepeek-inline-load-more-btn'), null);
  io.fire(); await tick(); assert.equal(p.calls.length, 1);
  p.query('.sidepeek-thread-group .sidepeek-expand-btn').click(); await tick();
  assert.ok(p.query('.sidepeek-inline-load-more-btn'));
  io.fire(); await tick(); assert.equal(p.calls.length, 1, 'expanding a preview does not enable automatic internal requests');
});

test('unlimited preview reveals observed descendants while its automatic continuation is pending', async t => {
  const io = observers();
  let finish;
  const parent = tweet('101', '100'); parent.core.user_results.result.rest_id = 'guest';
  const p = await open(t, m => m.cursor
    ? new Promise(resolve => { finish = resolve; })
    : detail([moduleEntry('101', [parent, tweet('102', '101'), tweet('103', '102')], 'a')]),
    { sidex_sub_reply_limit: 'all' }, io.setup);
  assert.ok(p.query('[data-id="103"]'));
  observeNative(p, detail([moduleEntry('101', [parent, tweet('102', '101'), tweet('103', '102'), tweet('104', '103')], 'a')]));
  await tick(); assert.ok(p.query('[data-id="104"]'));
  io.fire(); await tick(); assert.equal(p.calls.length, 2);
  assert.ok(p.query('.sidepeek-inline-load-more-btn'));
  finish(detail([moduleEntry('101', [tweet('105', '104')])], { posts: [] })); await tick();
  assert.ok(p.query('[data-id="105"]'));
  assert.equal(p.calls.filter(m => m.cursor).length, 1);
});

test('gated inline continuations are not exposed or fetched before explicit expansion', async t => {
  const io = observers();
  const json = initial();
  json.data.instructions[0].entries.splice(1, 0, { content: { itemContent: { itemType: 'TimelineLabel', text: 'Probable spam' } } });
  const p = await open(t, () => json, {}, io.setup);
  assert.equal(p.query('[data-id="101"]'), null);
  assert.equal(p.query('.sidepeek-inline-load-more-btn'), null);
  io.fire(); await tick(); assert.equal(p.calls.length, 1);
  p.query('.sidepeek-gated-btn').click(); await tick();
  assert.ok(p.query('[data-id="101"]'));
  assert.ok(p.query('.sidepeek-inline-load-more-btn'));
  assert.ok(p.query('.sidepeek-section-label'));
  io.fire(); await tick(); assert.equal(p.calls.length, 1, 'spam continuation remains manual');
});

for (const reversed of [false, true]) {
  test(`reopening reconciles a completed cached module with a stale initial cursor (reversed=${reversed})`, async t => {
    const start = initial('a');
    const done = detail([moduleEntry('101', [tweet('103', '102'), tweet('104', '103')])], { posts: [] });
    for (const response of [start, done]) {
      for (const entry of response.data.instructions[0].entries) {
        for (const item of entry.content?.items || []) {
          const post = item.item?.itemContent?.tweet_results?.result;
          if (post) post.core.user_results.result.rest_id = 'guest';
        }
      }
    }
    const snapshots = [{ requestTweetId: '100', cursor: '', json: start },
      { requestTweetId: '100', cursor: 'a', json: done }];
    if (reversed) snapshots.reverse();
    const p = await open(t, () => ({ ...start, sidepeekObservedThreads: snapshots }),
      { sidex_sub_reply_limit: 1, sidex_auto_load_replies: false });
    for (let round = 0; round < 2; round++) {
      p.query('.sidepeek-thread-group .sidepeek-expand-btn').click(); await tick();
      assert.deepEqual([...p.w.document.querySelectorAll('.sidepeek-thread-group article')].map(n => n.dataset.id), ['101', '102', '103', '104']);
      assert.ok(p.query('.sidepeek-collapse-btn'));
      assert.equal(p.query('.sidepeek-inline-load-more-btn'), null, 'completed cache must not restore an old cursor');
      if (!round) { p.query('.sidepeek-btn-close').click(); p.clickPost(0); await tick(); }
    }
    assert.equal(p.calls.filter(m => m.cursor).length, 0);
  });
}

test('cached cursor progress advances only its module and preserves direct repeated-cursor responses', t => {
  const dom = new JSDOM('', { runScripts: 'outside-only' }); t.after(() => dom.window.close());
  dom.window.eval(source('core.js')); const core = dom.window.SidePeekCore;
  const start = detail([moduleEntry('101', [tweet('101', '100'), tweet('102', '101')], 'a'),
    moduleEntry('110', [tweet('110', '100'), tweet('111', '110')], 'other')]);
  const next = detail([moduleEntry('101', [tweet('103', '102')], 'b')], { posts: [] });
  const json = { ...start, sidepeekObservedThreads: [{ requestTweetId: '100', cursor: 'a', json: next }] };
  const cursors = value => Array.from(value.pagination.inlineCursors, p => p.cursor);
  assert.deepEqual(cursors(core.parseTweetDetail(json, '100')), ['b', 'other']);
  const direct = { ...initial('a'), sidepeekObservedThreads: [{ requestTweetId: '100', cursor: 'a', json: next }] };
  assert.deepEqual(cursors(core.parseTweetDetail(direct, '100', [], '', { requestCursor: 'a' })), ['a']);
  const done = detail([moduleEntry('101', [tweet('104', '103')])], { posts: [] });
  const chain = { ...start, sidepeekObservedThreads: [
    { requestTweetId: '100', cursor: 'b', json: done },
    { requestTweetId: '100', cursor: 'a', json: next }
  ] };
  assert.deepEqual(cursors(core.parseTweetDetail(chain, '100')), ['other']);
  const unrelated = { ...start, sidepeekObservedThreads: [{ requestTweetId: '999', cursor: 'a', json: done }] };
  assert.ok(cursors(core.parseTweetDetail(unrelated, '100')).includes('a'), 'a different request cannot consume this cursor');
  const unknown = { ...start, sidepeekObservedThreads: [{ requestTweetId: '100', cursor: 'a', json: detail([], { posts: [] }) }] };
  assert.deepEqual(cursors(core.parseTweetDetail(unknown, '100')), ['a', 'other'], 'absence of module evidence is not completion');
  const failed = { ...start, sidepeekObservedThreads: [{ requestTweetId: '100', cursor: 'a', json: { ...next, errors: [{ message: 'failed' }] } }] };
  assert.deepEqual(cursors(core.parseTweetDetail(failed, '100')), ['a', 'other']);
});
