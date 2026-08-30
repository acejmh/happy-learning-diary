/**
 * 핸들러 통합 검증. Gemini 호출은 stub 으로 갈아끼운다.
 * 실제 API 키도 네트워크도 필요 없다.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleAnalyze } from '../src/analyze.js';
import { MemoryRateLimiter } from '../src/guard.js';

const ORIGIN = 'https://diary.example';
const ENV = { GEMINI_API_KEY: 'test-key', ALLOWED_ORIGINS: ORIGIN };
const TEXT = '오늘 수학시간에 곱셈을 배웠다.\n정말 재미있엇다. 나는 곱셈 좋다.';

const realFetch = globalThis.fetch;
let lastGeminiBody = null;

/** Gemini 엔드포인트만 가로채고 나머지는 원래대로 흘린다. */
function stubGemini(replyText) {
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      lastGeminiBody = JSON.parse(init.body);

      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: replyText }] } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    return realFetch(url, init);
  };
}

function request(body, headers = {}) {
  return new Request(ORIGIN + '/api/analyze', {
    method: 'POST',
    headers: { origin: ORIGIN, ...headers },
    body
  });
}

const jsonReq = (obj) =>
  request(JSON.stringify(obj), { 'content-type': 'application/json' });

const run = (req, env = ENV, limiter = new MemoryRateLimiter()) =>
  handleAnalyze(req, { env, limiter });

const send = (obj) => run(jsonReq(obj));

/* ───────────────────────────────── 가드 */

test('GET 은 405', async () => {
  const res = await run(new Request(ORIGIN + '/api/analyze', {
    headers: { origin: ORIGIN }
  }));

  assert.equal(res.status, 405);
});

test('타 origin 은 403', async () => {
  const res = await run(request('{}', {
    origin: 'https://evil.example',
    'content-type': 'application/json'
  }));

  assert.equal(res.status, 403);
});

test('Origin 없는 직접 호출은 403', async () => {
  const res = await run(new Request(ORIGIN + '/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  }));

  assert.equal(res.status, 403);
});

test('일일 상한을 넘기면 429', async () => {
  stubGemini(JSON.stringify({ items: [] }));

  const limiter = new MemoryRateLimiter();
  const env = { ...ENV, DAILY_PER_IP_LIMIT: '1' };

  await handleAnalyze(jsonReq({ mode: 'find', text: TEXT, mission: 1 }), { env, limiter });

  const res = await handleAnalyze(
    jsonReq({ mode: 'find', text: TEXT, mission: 1 }), { env, limiter }
  );

  assert.equal(res.status, 429);
});

/* ───────────────────────────────── 사진 OCR */

test('사진 업로드 → OCR 텍스트 반환', async () => {
  stubGemini('오늘 수학시간에 곱셈을 배웠다.');

  const form = new FormData();
  form.append('image', new File([new Uint8Array([1, 2, 3, 4])], 'a.jpg', { type: 'image/jpeg' }));

  const res = await run(request(form));
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.text, '오늘 수학시간에 곱셈을 배웠다.');
  assert.ok(lastGeminiBody.contents[0].parts[1].inlineData.data, 'base64 이미지가 실려야 한다');
});

test('이미지가 아닌 파일은 400', async () => {
  const form = new FormData();
  form.append('image', new File(['hello'], 'a.txt', { type: 'text/plain' }));

  assert.equal((await run(request(form))).status, 400);
});

test('4MB 초과 사진은 413', async () => {
  const form = new FormData();
  form.append('image', new File([new Uint8Array(4 * 1024 * 1024 + 10)], 'big.jpg', { type: 'image/jpeg' }));

  const res = await run(request(form));

  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /너무 커요/);
});

/* ───────────────────────────────── mode 분기 */

test('mode 가 없으면 400', async () => {
  const res = await send({ text: TEXT, mission: 1 });

  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /find 또는 grade/);
});

test('본문이 JSON 이 아니면 400', async () => {
  const res = await run(request('보통 글', { 'content-type': 'application/json' }));

  assert.equal(res.status, 400);
});

/* ───────────────────────────────── find */

test('find: 원문에 없는 항목과 중복은 버린다', async () => {
  stubGemini(JSON.stringify({ items: [
    { wrong: '재미있엇다', ctx: '정말 재미있엇다.', hint: '받침을 살펴볼까요?' },
    { wrong: '재미있었다', ctx: '정말 재미있었다.', hint: '모델이 고쳐서 보낸 것' },
    { wrong: '재미있엇다', ctx: '정말 재미있엇다.', hint: '중복' }
  ] }));

  const res = await send({ mode: 'find', text: TEXT, mission: 1 });
  const d = await res.json();

  assert.equal(res.status, 200);
  assert.equal(d.kind, 'word');
  assert.equal(d.items.length, 1);
  assert.equal(d.items[0].wrong, '재미있엇다');
  assert.equal(d.items[0].ctx, '정말 재미있엇다.');
});

test('find: 응답에 정답이 들어 있으면 안 된다', async () => {
  stubGemini(JSON.stringify({ items: [
    { wrong: '재미있엇다', ctx: '정말 재미있엇다.', hint: 'h', answer: '재미있었다' }
  ] }));

  const d = await (await send({ mode: 'find', text: TEXT, mission: 1 })).json();

  assert.ok(!('answer' in d.items[0]), 'find 단계에서 정답이 새면 안 된다');
  assert.ok(!JSON.stringify(d).includes('재미있었다'));
});

test('find: 원문에 없는 ctx 는 비운다', async () => {
  stubGemini(JSON.stringify({ items: [
    { wrong: '수학시간에', ctx: '지어낸 문장입니다.', hint: 'h' }
  ] }));

  const d = await (await send({ mode: 'find', text: TEXT, mission: 2 })).json();

  assert.equal(d.items[0].ctx, '');
});

test('find(문장): mark 가 문장 안에 있어야 남는다', async () => {
  stubGemini(JSON.stringify({ items: [
    { wrong: '나는 곱셈 좋다.', mark: '곱셈', hint: 'h' }
  ] }));

  const d = await (await send({ mode: 'find', text: TEXT, mission: 3 })).json();

  assert.equal(d.kind, 'sentence');
  assert.equal(d.items[0].mark, '곱셈');
});

test('find(문장): 문장에 없는 mark 는 비운다', async () => {
  stubGemini(JSON.stringify({ items: [
    { wrong: '나는 곱셈 좋다.', mark: '없는말', hint: 'h' }
  ] }));

  const d = await (await send({ mode: 'find', text: TEXT, mission: 3 })).json();

  assert.equal(d.items[0].mark, '');
});

test('find: 고칠 것이 없으면 빈 배열', async () => {
  stubGemini(JSON.stringify({ items: [] }));

  const d = await (await send({ mode: 'find', text: TEXT, mission: 1 })).json();

  assert.deepEqual(d.items, []);
});

test('find: 잘못된 mission 은 400, 빈 글은 400, 긴 글은 413', async () => {
  assert.equal((await send({ mode: 'find', text: TEXT, mission: 9 })).status, 400);
  assert.equal((await send({ mode: 'find', text: '', mission: 1 })).status, 400);
  assert.equal((await send({ mode: 'find', text: 'ㄱ'.repeat(5000), mission: 1 })).status, 413);
});

/* ───────────────────────────────── grade */

test('grade: 맞히면 정답과 이유가 내려온다', async () => {
  stubGemini(JSON.stringify({ results: [
    { wrong: '재미있엇다', ok: true, answer: '재미있었다', why: '지난 일은 었을 써요.' }
  ] }));

  const d = await (await send({
    mode: 'grade', text: TEXT, mission: 1,
    answers: [{ wrong: '재미있엇다', input: '재미있었다' }]
  })).json();

  assert.equal(d.passed, true);
  assert.equal(d.results[0].ok, true);
  assert.equal(d.results[0].answer, '재미있었다');
  assert.ok(d.results[0].why);
});

test('grade: 틀리면 정답을 숨긴다', async () => {
  stubGemini(JSON.stringify({ results: [
    { wrong: '재미있엇다', ok: false, answer: '재미있었다', why: '설명' }
  ] }));

  const d = await (await send({
    mode: 'grade', text: TEXT, mission: 1,
    answers: [{ wrong: '재미있엇다', input: '재미잇다' }]
  })).json();

  assert.equal(d.passed, false);
  assert.ok(!('answer' in d.results[0]), '틀렸는데 정답이 새면 안 된다');
  assert.ok(!('why' in d.results[0]));
  assert.ok(!JSON.stringify(d).includes('재미있었다'));
});

test('grade: reveal 이면 틀려도 정답을 준다', async () => {
  stubGemini(JSON.stringify({ results: [
    { wrong: '재미있엇다', ok: false, answer: '재미있었다', why: '설명' }
  ] }));

  const d = await (await send({
    mode: 'grade', text: TEXT, mission: 1, reveal: true,
    answers: [{ wrong: '재미있엇다', input: '' }]
  })).json();

  assert.equal(d.results[0].ok, false);
  assert.equal(d.results[0].answer, '재미있었다');
});

test('grade: 모델이 개수를 적게 줘도 보낸 만큼 돌려준다', async () => {
  stubGemini(JSON.stringify({ results: [{ ok: true, answer: 'A', why: 'w' }] }));

  const d = await (await send({
    mode: 'grade', text: TEXT, mission: 2,
    answers: [
      { wrong: '수학시간에', input: '수학 시간에' },
      { wrong: '두개', input: '두 개' }
    ]
  })).json();

  assert.equal(d.results.length, 2, '빠진 자리는 못 맞힘으로 채워야 한다');
  assert.equal(d.results[1].ok, false);
  assert.equal(d.results[0].wrong, '수학시간에', 'wrong 은 서버가 보낸 것으로 고정');
});

test('grade: 항목이 없으면 400, 너무 길면 413', async () => {
  assert.equal((await send({ mode: 'grade', text: TEXT, mission: 1, answers: [] })).status, 400);
  assert.equal((await send({
    mode: 'grade', text: TEXT, mission: 1,
    answers: [{ wrong: 'ㄱ'.repeat(500), input: 'a' }]
  })).status, 413);
});

/* ───────────────────────────────── 오류 처리 */

test('AI 가 JSON 이 아닌 것을 주면 502 이고 raw 는 새지 않는다', async () => {
  stubGemini('죄송합니다 도와드릴 수 없습니다');

  const res = await send({ mode: 'find', text: TEXT, mission: 1 });
  const d = await res.json();

  assert.equal(res.status, 502);
  assert.ok(!JSON.stringify(d).includes('죄송합니다'));
});

test('Gemini 오류 메시지가 클라이언트로 새지 않는다', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'API key AIzaSyLEAKED invalid' } }), {
      status: 400
    });

  const d = await (await send({ mode: 'find', text: TEXT, mission: 1 })).json();

  assert.ok(!JSON.stringify(d).includes('AIzaSy'), '상류 키 힌트가 노출되면 안 된다');
});

test.after(() => {
  globalThis.fetch = realFetch;
});
