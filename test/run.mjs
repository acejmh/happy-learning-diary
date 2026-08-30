/**
 * 의존성 없는 최소 검증. `npm test` 로 실행.
 * 네트워크나 API 키 없이 도는 순수 함수/가드 로직만 확인한다.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { extractJson } from '../src/analyze.js';
import {
  MemoryRateLimiter,
  checkOrigin,
  clientIp,
  enforceRateLimit,
  seoulDateKey
} from '../src/guard.js';
import { buildCheckPrompt } from '../src/prompts.js';

/* app.js 는 브라우저용이라 순수 함수 구간만 잘라서 불러온다. */
async function loadClientPureFns() {
  const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = src.indexOf('function escapeHtml');
  const end = src.indexOf('/* ------------------------------------------------------------ 사진 리사이즈');

  assert.ok(start !== -1 && end > start, 'app.js 의 순수 함수 구간을 찾지 못했습니다.');

  const code = src.slice(start, end) +
    '\nexport { escapeHtml, highlightDiff, tokenize };';

  return import('data:text/javascript,' + encodeURIComponent(code));
}

const client = await loadClientPureFns();

test('highlightDiff: HTML 엔티티가 깨지지 않는다', () => {
  const html = client.highlightDiff("I don't know", "I don't understand");

  assert.ok(html.includes('&#039;'), '작은따옴표가 엔티티로 남아야 한다');
  assert.ok(!/&#<span/.test(html), '엔티티 안쪽이 쪼개지면 안 된다');
  assert.ok(!/&amp;#/.test(html), '이중 이스케이프가 없어야 한다');
});

test('highlightDiff: 큰따옴표/앰퍼샌드도 안전하다', () => {
  for (const [a, b] of [
    ['오늘 친구가 재밌다 했다', '오늘 친구가 "재밌다" 했다'],
    ['엄마 아빠와 갔다', '엄마 & 아빠가 갔다']
  ]) {
    const html = client.highlightDiff(a, b);
    assert.ok(!/&(quot|amp|#039)<span/.test(html), `엔티티 파손: ${html}`);
  }
});

test('highlightDiff: 띄어쓰기만 고쳐도 하이라이트가 잡힌다', () => {
  const html = client.highlightDiff(
    '오늘 수학시간에 곱셈을 배웠다',
    '오늘 수학 시간에 곱셈을 배웠다'
  );

  assert.ok(html.includes('highlight'), '띄어쓰기 교정이 표시되어야 한다');
});

test('highlightDiff: 변경이 없으면 하이라이트도 없다', () => {
  const html = client.highlightDiff('오늘은 즐거웠다', '오늘은 즐거웠다');

  assert.ok(!html.includes('highlight'));
});

test('escapeHtml: 위험 문자를 모두 막는다', () => {
  assert.equal(
    client.escapeHtml('<img src=x onerror="alert(1)">'),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
  );
});

test('checkOrigin: 자기 origin 만 통과시킨다', () => {
  const ok = new Request('https://a.example/api/analyze', {
    method: 'POST',
    headers: { origin: 'https://a.example' }
  });

  assert.equal(checkOrigin(ok, ''), 'https://a.example');

  const cross = new Request('https://a.example/api/analyze', {
    method: 'POST',
    headers: { origin: 'https://evil.example' }
  });

  assert.throws(() => checkOrigin(cross, ''), /허용되지 않은 출처/);
});

test('checkOrigin: Origin 없는 직접 호출(curl)은 막힌다', () => {
  const bare = new Request('https://a.example/api/analyze', { method: 'POST' });

  assert.throws(() => checkOrigin(bare, ''), /브라우저에서만/);
});

test('checkOrigin: ALLOWED_ORIGINS 목록을 존중한다', () => {
  const req = new Request('https://worker.dev/api/analyze', {
    method: 'POST',
    headers: { origin: 'https://diary.example' }
  });

  assert.equal(
    checkOrigin(req, 'https://diary.example/, https://other.example'),
    'https://diary.example'
  );
});

test('enforceRateLimit: IP 상한을 넘기면 429', async () => {
  const limiter = new MemoryRateLimiter();
  const env = { DAILY_PER_IP_LIMIT: '2', DAILY_CALL_LIMIT: '100' };

  await enforceRateLimit(limiter, '1.1.1.1', env);
  await enforceRateLimit(limiter, '1.1.1.1', env);

  await assert.rejects(
    () => enforceRateLimit(limiter, '1.1.1.1', env),
    (e) => e.status === 429
  );

  // 다른 IP 는 여전히 통과해야 한다.
  await enforceRateLimit(limiter, '2.2.2.2', env);
});

test('enforceRateLimit: 전체 상한도 걸린다', async () => {
  const limiter = new MemoryRateLimiter();
  const env = { DAILY_PER_IP_LIMIT: '100', DAILY_CALL_LIMIT: '2' };

  await enforceRateLimit(limiter, 'a', env);
  await enforceRateLimit(limiter, 'b', env);

  await assert.rejects(
    () => enforceRateLimit(limiter, 'c', env),
    (e) => e.status === 429
  );
});

test('clientIp: Cloudflare / Netlify 헤더를 모두 읽는다', () => {
  const cf = new Request('https://a.example', {
    headers: { 'cf-connecting-ip': '3.3.3.3' }
  });

  assert.equal(clientIp(cf), '3.3.3.3');

  const nf = new Request('https://a.example', {
    headers: { 'x-forwarded-for': '4.4.4.4, 5.5.5.5' }
  });

  assert.equal(clientIp(nf), '4.4.4.4');
  assert.equal(clientIp(new Request('https://a.example'), { ip: '6.6.6.6' }), '6.6.6.6');
});

test('seoulDateKey: KST 로 날짜가 넘어간다', () => {
  // UTC 2026-08-30 15:30 => KST 2026-08-31 00:30
  assert.equal(seoulDateKey(new Date('2026-08-30T15:30:00Z')), '2026-08-31');
  assert.equal(seoulDateKey(new Date('2026-08-30T14:30:00Z')), '2026-08-30');
});

test('extractJson: 코드펜스와 잡텍스트를 걷어낸다', () => {
  assert.deepEqual(extractJson('```json\n{"pass":true}\n```'), { pass: true });
  assert.deepEqual(extractJson('설명 {"pass":false} 끝'), { pass: false });
});

test('buildCheckPrompt: 미션 범위 밖은 고치지 말라고 지시한다', () => {
  const p2 = buildCheckPrompt({ original: 'a', answer: 'b', mission: '2' });

  assert.ok(p2.includes('띄어쓰기 미션'));
  assert.ok(p2.includes('[이번 미션에서 보지 않을 것]'));
  assert.ok(p2.includes('일부러 그대로 두세요'));

  const p3 = buildCheckPrompt({ original: 'a', answer: 'b', mission: '3' });

  assert.ok(p3.includes('조사·문맥 미션'));
});
