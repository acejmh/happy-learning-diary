/**
 * 핸들러 통합 스모크 테스트. Gemini 호출은 stub 으로 갈아끼운다.
 * 실제 API 키도 네트워크도 필요 없다.  `node test/handler.mjs`
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleAnalyze } from '../src/analyze.js';
import { MemoryRateLimiter } from '../src/guard.js';

const ORIGIN = 'https://diary.example';
const ENV = { GEMINI_API_KEY: 'test-key', ALLOWED_ORIGINS: ORIGIN };

const realFetch = globalThis.fetch;
let lastGeminiBody = null;

/** Gemini 엔드포인트만 가로채고 나머지는 원래대로 흘린다. */
function stubGemini(replyText) {
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      lastGeminiBody = JSON.parse(init.body);

      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: replyText }] } }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    return realFetch(url, init);
  };
}

function post(body, headers = {}) {
  return new Request('https://diary.example/api/analyze', {
    method: 'POST',
    headers: { origin: ORIGIN, ...headers },
    body
  });
}

const run = (request, limiter = new MemoryRateLimiter()) =>
  handleAnalyze(request, { env: ENV, limiter });

test('GET 은 405', async () => {
  const res = await run(new Request('https://diary.example/api/analyze', {
    headers: { origin: ORIGIN }
  }));

  assert.equal(res.status, 405);
});

test('타 origin 은 403', async () => {
  const res = await run(post(JSON.stringify({}), { origin: 'https://evil.example' }));

  assert.equal(res.status, 403);
});

test('Origin 없는 직접 호출은 403', async () => {
  const res = await run(new Request('https://diary.example/api/analyze', {
    method: 'POST',
    body: '{}'
  }));

  assert.equal(res.status, 403);
});

test('사진 업로드 → OCR 텍스트 반환', async () => {
  stubGemini('오늘 수학시간에 곱셈을 배웠다.');

  const form = new FormData();
  form.append('image', new File([new Uint8Array([1, 2, 3, 4])], 'a.jpg', { type: 'image/jpeg' }));

  const res = await run(post(form));
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.text, '오늘 수학시간에 곱셈을 배웠다.');
  assert.ok(lastGeminiBody.contents[0].parts[1].inlineData.data, 'base64 이미지가 실려야 한다');
});

test('이미지가 아닌 파일은 400', async () => {
  const form = new FormData();
  form.append('image', new File(['hello'], 'a.txt', { type: 'text/plain' }));

  const res = await run(post(form));

  assert.equal(res.status, 400);
});

test('4MB 초과 사진은 413', async () => {
  const form = new FormData();
  const big = new Uint8Array(4 * 1024 * 1024 + 10);

  form.append('image', new File([big], 'big.jpg', { type: 'image/jpeg' }));

  const res = await run(post(form));
  const data = await res.json();

  assert.equal(res.status, 413);
  assert.match(data.error, /너무 커요/);
});

test('첨삭 요청 → pass/corrections 반환', async () => {
  stubGemini(JSON.stringify({
    pass: true,
    feedback: '잘 고쳤어요!',
    corrected: '오늘 수학 시간에 곱셈을 배웠다.',
    corrections: [{ before: '수학시간에', after: '수학 시간에', reason: '띄어 써요.' }]
  }));

  const res = await run(post(
    JSON.stringify({ original: '오늘 수학시간에 곱셈을 배웠다.', answer: '오늘 수학 시간에 곱셈을 배웠다.', mission: 2 }),
    { 'content-type': 'application/json' }
  ));

  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.pass, true);
  assert.equal(data.corrections.length, 1);
  assert.ok(lastGeminiBody.contents[0].parts[0].text.includes('띄어쓰기 미션'));
});

test('잘못된 mission 번호는 400', async () => {
  const res = await run(post(
    JSON.stringify({ original: 'a', answer: 'b', mission: 9 }),
    { 'content-type': 'application/json' }
  ));

  assert.equal(res.status, 400);
});

test('너무 긴 글은 413', async () => {
  const res = await run(post(
    JSON.stringify({ original: 'ㄱ'.repeat(5000), answer: 'b', mission: 1 }),
    { 'content-type': 'application/json' }
  ));

  assert.equal(res.status, 413);
});

test('Gemini 오류 메시지가 클라이언트로 새지 않는다', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'API key AIzaSyLEAKED invalid' } }), {
      status: 400
    });

  const res = await run(post(
    JSON.stringify({ original: 'a', answer: 'bbbbb', mission: 1 }),
    { 'content-type': 'application/json' }
  ));

  const data = await res.json();

  assert.ok(!JSON.stringify(data).includes('AIzaSy'), '상류 키 힌트가 노출되면 안 된다');
});

test('일일 상한을 넘기면 429', async () => {
  stubGemini('ok');

  const limiter = new MemoryRateLimiter();
  const env = { ...ENV, DAILY_PER_IP_LIMIT: '1' };
  const make = () => post(
    JSON.stringify({ original: 'a', answer: 'bbbbb', mission: 1 }),
    { 'content-type': 'application/json' }
  );

  await handleAnalyze(make(), { env, limiter });

  const res = await handleAnalyze(make(), { env, limiter });

  assert.equal(res.status, 429);
});

test.after(() => {
  globalThis.fetch = realFetch;
});
