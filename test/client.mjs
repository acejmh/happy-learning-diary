/**
 * public/app.js 의 순수 함수 구간만 잘라서 검증한다.
 * app.js 는 브라우저용이라 통째로 import 할 수 없다.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const SRC = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

const START = 'function escapeHtml';
const END = '/* ==== 순수 함수 끝 ==== */';

const start = SRC.indexOf(START);
const end = SRC.indexOf(END);

assert.ok(start !== -1, 'app.js 에서 escapeHtml 을 찾지 못했습니다.');
assert.ok(end > start, 'app.js 에 "순수 함수 끝" 표시가 없습니다.');

const mod = await import(
  'data:text/javascript,' +
  encodeURIComponent(SRC.slice(start, end) + '\nexport { escapeHtml, wrap, paint, buildAfter };')
);

const { escapeHtml, wrap, paint, buildAfter } = mod;

/* ───────────────────────────────── escapeHtml */

test('escapeHtml: 위험 문자를 모두 막는다', () => {
  assert.equal(
    escapeHtml('<img src=x onerror="alert(1)">'),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
  );
  assert.equal(escapeHtml("don't & <b>"), 'don&#039;t &amp; &lt;b&gt;');
});

/* ───────────────────────────────── paint */

test('paint: 바뀐 낱말만 감싼다', () => {
  const html = paint('오늘 수학시간에 곱셈을 배웠다', ['수학시간에'], 'was');

  assert.equal(html, '오늘 <span class="was">수학시간에</span> 곱셈을 배웠다');
});

test('paint: HTML 엔티티가 갈라지지 않는다', () => {
  const html = paint('친구가 "재밌다" 했다. 집에 갓다.', ['갓다'], 'was');

  assert.ok(html.includes('&quot;재밌다&quot;'), '따옴표가 엔티티로 온전해야 한다');
  assert.ok(!/&[a-z#0-9]*<span/.test(html), '엔티티 안쪽이 쪼개지면 안 된다');
  assert.ok(!html.includes('&amp;quot;'), '이중 이스케이프가 없어야 한다');
});

test('paint: 앰퍼샌드와 작은따옴표도 안전하다', () => {
  for (const [text, words] of [
    ["I don't know", ['know']],
    ['엄마 & 아빠가 갔다', ['갔다']]
  ]) {
    const html = paint(text, words, 'now');
    assert.ok(!/&[a-z#0-9]*<span/.test(html), `엔티티 파손: ${html}`);
  }
});

test('paint: 띄어쓰기 교정도 잡힌다', () => {
  const html = paint('오늘 수학 시간에 곱셈을', ['수학 시간에'], 'now');

  assert.ok(html.includes('<span class="now">수학 시간에</span>'));
});

test('paint: 여러 낱말을 각각 감싼다', () => {
  const html = paint('정말 재미있엇다. 집에 갓다.', ['재미있엇다', '갓다'], 'was');

  assert.equal((html.match(/<span class="was">/g) || []).length, 2);
});

test('paint: 바꿀 것이 없으면 이스케이프만 한다', () => {
  assert.equal(paint('오늘은 <즐거웠다>', [], 'was'), '오늘은 &lt;즐거웠다&gt;');
});

test('paint: 자리표시자가 결과에 남지 않는다', () => {
  const html = paint('집에 갓다', ['갓다'], 'was');

  assert.ok(!html.includes('⁣'), '보이지 않는 구분자가 새어 나오면 안 된다');
});

test('paint: 감싸는 낱말 자체도 이스케이프된다', () => {
  const html = paint('그는 <b>이라고 썼다', ['<b>'], 'was');

  assert.ok(html.includes('<span class="was">&lt;b&gt;</span>'));
});

/* ───────────────────────────────── wrap */

test('wrap: 임의의 태그로 감쌀 수 있다', () => {
  assert.equal(
    wrap('나는 곱셈 좋다.', ['곱셈'], '<u>', '</u>'),
    '나는 <u>곱셈</u> 좋다.'
  );
  assert.equal(
    wrap('오늘 수학시간에 배웠다', ['수학시간에'], '<mark>', '</mark>'),
    '오늘 <mark>수학시간에</mark> 배웠다'
  );
});

test('wrap: 감쌀 말이 비어 있으면 이스케이프만 한다', () => {
  assert.equal(wrap('"안녕" & 잘가', [''], '<u>', '</u>'), '&quot;안녕&quot; &amp; 잘가');
  assert.equal(wrap('"안녕"', [], '<u>', '</u>'), '&quot;안녕&quot;');
});

test('wrap: 문장에 없는 말을 주면 아무것도 안 감싼다', () => {
  assert.equal(wrap('나는 곱셈 좋다.', ['없는말'], '<u>', '</u>'), '나는 곱셈 좋다.');
});

/* ───────────────────────────────── buildAfter */

test('buildAfter: 고친 내용을 원문에 적용한다', () => {
  const text = '오늘 수학시간에 곱셈을 배웠다. 정말 재미있엇다.';
  const log = [
    { wrong: '수학시간에', answer: '수학 시간에' },
    { wrong: '재미있엇다', answer: '재미있었다' }
  ];

  assert.equal(
    buildAfter(text, log),
    '오늘 수학 시간에 곱셈을 배웠다. 정말 재미있었다.'
  );
});

test('buildAfter: 문장 단위 교정도 적용된다', () => {
  const text = '오늘 배웠다.\n나는 곱셈 좋다.';
  const log = [{ wrong: '나는 곱셈 좋다.', answer: '나는 곱셈이 좋다.' }];

  assert.equal(buildAfter(text, log), '오늘 배웠다.\n나는 곱셈이 좋다.');
});

test('buildAfter: 고친 것이 없으면 원문 그대로', () => {
  assert.equal(buildAfter('오늘은 즐거웠다', []), '오늘은 즐거웠다');
});

test('buildAfter: 같은 낱말이 여러 번 나오면 모두 바꾼다', () => {
  assert.equal(
    buildAfter('갓다. 또 갓다.', [{ wrong: '갓다', answer: '갔다' }]),
    '갔다. 또 갔다.'
  );
});

/* ───────────────────────────────── 전/후 화면 조합 */

test('전·후 패널이 서로 다른 색으로 같은 개수를 표시한다', () => {
  const text = '오늘 수학시간에 곱셈을 배웠다. 정말 재미있엇다.';
  const log = [
    { wrong: '수학시간에', answer: '수학 시간에' },
    { wrong: '재미있엇다', answer: '재미있었다' }
  ];

  const after = buildAfter(text, log);
  const beforeHtml = paint(text, log.map((l) => l.wrong), 'was');
  const afterHtml = paint(after, log.map((l) => l.answer), 'now');

  assert.equal((beforeHtml.match(/class="was"/g) || []).length, 2);
  assert.equal((afterHtml.match(/class="now"/g) || []).length, 2);
  assert.ok(beforeHtml.includes('재미있엇다'), '전 패널에는 원래 오류가 남아야 한다');
  assert.ok(afterHtml.includes('재미있었다'), '후 패널에는 고친 결과가 있어야 한다');
});
