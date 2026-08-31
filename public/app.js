'use strict';

/* 플랫폼 중립 경로. Vercel 은 api/analyze.js 가, Cloudflare 는 worker 라우팅이,
   Netlify 는 netlify.toml 리다이렉트가 같은 곳으로 보낸다. */
const API_URL = '/api/analyze';

/* 업로드 전 리사이즈 기준.
   서버리스 함수의 요청 페이로드 상한(4~4.5MB)에 폰 사진(3~8MB)이 그대로 걸린다.
   긴 변 1600px / JPEG 0.8 이면 OCR 정확도는 유지되면서 대개 300KB 안쪽으로 떨어진다. */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.8;

const MISSION_NAMES = { 1: '맞춤법', 2: '띄어쓰기', 3: '조사·문장' };
const STEPS = ['사진', '확인', '맞춤법', '띄어쓰기', '조사·문장', '완료'];
const LAST_MISSION = 3;

/* ══════════════════════════════════════════════════════════
   순수 함수 — test/client.mjs 가 이 구간만 잘라서 검증한다.
   ══════════════════════════════════════════════════════════ */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[c]));
}

/** 자리표시자로 쓸 보이지 않는 문자. 본문에 나올 일이 없다. */
const SEP = '⁣';

/**
 * words 에 해당하는 부분만 <span class="cls"> 로 감싼다.
 *
 * 자리표시자로 먼저 쪼갠 뒤 조각별로 이스케이프하는 순서가 핵심이다.
 * 이스케이프를 먼저 하고 태그를 끼우면 &quot; 같은 엔티티 안쪽이 갈라져
 * 화면에 &quot; 가 그대로 노출된다.
 */
function wrap(text, words, open, close) {
  let out = String(text);

  words.forEach((w, i) => {
    if (w) out = out.split(w).join(SEP + i + SEP);
  });

  return out.split(SEP).map((part, idx) =>
    idx % 2 === 1
      ? open + escapeHtml(words[Number(part)]) + close
      : escapeHtml(part)
  ).join('');
}

function paint(text, words, cls) {
  return wrap(text, words, '<span class="' + cls + '">', '</span>');
}

/** 원문에 고친 내용을 순서대로 적용해 "고친 글" 을 만든다. */
function buildAfter(text, log) {
  return log.reduce((t, l) => t.split(l.wrong).join(l.answer), String(text));
}

/* ==== 순수 함수 끝 ==== */

const $ = (id) => document.getElementById(id);

const state = {
  step: 0,
  file: null,        // 사용자가 고른 원본
  prepared: null,    // 회전·축소를 마친, 실제로 보낼 파일
  rotation: 0,       // 0 / 90 / 180 / 270
  previewUrl: null,
  text: '',       // 아이가 확정한 원본
  items: [],      // 이번 미션에서 고칠 항목
  kind: 'word',
  log: []         // { wrong, answer, why, tag }
};

/* ─────────────────────────────────────────── 통신 */

/** 응답이 JSON 이 아닐 수도 있다(413, 502, 프록시 HTML). 절대 터지지 않게 읽는다. */
async function readJson(response) {
  const body = await response.text();

  try {
    return JSON.parse(body);
  } catch {
    return { error: '서버가 예상치 못한 응답을 보냈어요. (HTTP ' + response.status + ')' };
  }
}

async function callApi(payload) {
  const init = payload instanceof FormData
    ? { method: 'POST', body: payload }
    : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      };

  const response = await fetch(API_URL, init);
  const data = await readJson(response);

  if (!response.ok) throw new Error(data.error || '요청에 실패했어요.');

  return data;
}

/* ─────────────────────────────────────────── 사진 리사이즈 */

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('사진을 열 수 없어요.')); };
    img.src = url;
  });
}

/**
 * 사진을 디코딩한다.
 * createImageBitmap 의 imageOrientation:'from-image' 는 EXIF 회전 정보를 반영해 준다.
 * 캔버스에 그대로 그리면 EXIF 가 무시돼 옆으로 누운 사진이 그대로 전송된다.
 */
async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (e) {
      // 지원하지 않는 브라우저는 아래로 떨어진다.
    }
  }

  return loadImage(file);
}

/**
 * 회전을 적용하고 긴 변을 MAX_EDGE 로 줄여 JPEG 로 다시 만든다.
 *
 * 사진이 옆으로 누워 있으면 글씨가 세로로 서고, 그러면 OCR 이 전사를 포기하고
 * 자기 생각을 늘어놓는다. 똑바로 세워서 보내는 것이 인식률의 핵심이다.
 */
async function prepareImage(file, rotation) {
  const quarter = ((rotation % 360) + 360) % 360;
  const source = await decodeImage(file);

  const w = source.width || source.naturalWidth;
  const h = source.height || source.naturalHeight;
  const longEdge = Math.max(w, h);

  // 돌릴 것도 없고 이미 작으면 원본을 그대로 쓴다.
  if (quarter === 0 && longEdge <= MAX_EDGE && file.size <= 1500000) {
    if (source.close) source.close();
    return file;
  }

  const scale = Math.min(1, MAX_EDGE / longEdge);
  const dw = Math.round(w * scale);
  const dh = Math.round(h * scale);
  const swap = quarter === 90 || quarter === 270;

  const canvas = document.createElement('canvas');
  canvas.width = swap ? dh : dw;
  canvas.height = swap ? dw : dh;

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(quarter * Math.PI / 180);
  ctx.drawImage(source, -dw / 2, -dh / 2, dw, dh);

  if (source.close) source.close();

  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', JPEG_QUALITY));

  if (!blob) {
    /* iOS Safari 는 큰 사진에서 toBlob 이 null 을 주는 일이 있다.
       돌리기를 눌렀는데 원본을 그냥 보내면 "왜 안 돌아가지?" 가 된다.
       차라리 왜 안 되는지 말해 준다. */
    if (quarter !== 0) {
      throw new Error('사진을 돌리지 못했어요. 사진을 조금 작게 찍어서 다시 올려 볼까요?');
    }

    return file;
  }

  return new File([blob], 'photo.jpg', { type: 'image/jpeg' });
}

/* ─────────────────────────────────────────── 화면 뼈대 */

function drawRail() {
  $('rail').innerHTML = STEPS.map((label, i) => {
    const st = i < state.step ? 'done' : i === state.step ? 'now' : 'todo';
    return '<span class="pip" data-state="' + st + '"><i></i><small>' + escapeHtml(label) + '</small></span>';
  }).join('');
}

function setStatus(message, kind) {
  const el = $('status');
  if (!el) return;
  el.textContent = message || '';
  if (kind) el.dataset.kind = kind; else delete el.dataset.kind;
}

function render() {
  drawRail();

  if (state.step === 0) return screenUpload();
  if (state.step === 1) return screenConfirm();
  if (state.step <= 1 + LAST_MISSION) return screenMission(state.step - 1);

  return screenDone();
}

function goto(step) {
  state.step = step;
  render();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

/* ─────────────────────────────────────────── 1단계: 사진 */

function screenUpload() {
  $('app').innerHTML =
    '<section class="card">' +
    '<p class="eyebrow">1단계</p>' +
    '<h2>배움일기 사진을 올려요</h2>' +
    '<p class="lede">공책을 찍은 사진을 올리면 글씨를 읽어 드려요. 그다음 세 가지 미션을 아빠랑 하나씩 풀어 봐요.</p>' +
    '<div class="drop" id="drop">' +
    '<b>📷 사진을 고르거나 여기로 끌어오세요</b>' +
    '<small>밝은 곳에서 공책이 화면에 꽉 차게 찍으면 잘 읽혀요</small>' +
    '<input id="file" type="file" accept="image/*" aria-label="배움일기 사진 고르기">' +
    '</div>' +
    '<img id="preview" class="preview" alt="고른 사진 미리보기" hidden>' +
    '<p class="status" id="status">사진을 먼저 골라 주세요.</p>' +
    '<div class="actions">' +
    '<button class="btn btn-go" id="read" disabled>사진 글씨 읽기</button>' +
    '<button class="btn btn-quiet" id="rotate" disabled>↻ 사진 돌리기</button>' +
    '</div>' +
    '<p class="tip">글씨가 옆으로 누워 있으면 <b>사진 돌리기</b>로 똑바로 세워 주세요. 그래야 잘 읽어요.</p>' +
    '</section>';

  const drop = $('drop');

  $('file').onchange = (e) => acceptFile(e.target.files[0]);

  ['dragenter', 'dragover'].forEach((t) =>
    drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));

  ['dragleave', 'drop'].forEach((t) =>
    drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));

  drop.addEventListener('drop', (e) => acceptFile(e.dataTransfer.files[0]));

  $('read').onclick = runOcr;

  $('rotate').onclick = () => {
    state.rotation = (state.rotation + 90) % 360;
    refreshPreview();
  };

  if (state.file) refreshPreview();
}

/**
 * 미리보기는 회전·축소를 마친 **실제로 보낼 그림**을 보여 준다.
 * 화면에서 본 그대로가 서버로 가야 "돌렸는데 왜 그대로지?" 가 생기지 않는다.
 */
async function refreshPreview() {
  $('rotate').disabled = true;
  $('read').disabled = true;

  try {
    state.prepared = await prepareImage(state.file, state.rotation);

    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = URL.createObjectURL(state.prepared);

    const img = $('preview');
    img.src = state.previewUrl;
    img.hidden = false;
  } catch (error) {
    setStatus(error.message, 'bad');
    return;
  } finally {
    if ($('rotate')) $('rotate').disabled = !state.file;
    if ($('read')) $('read').disabled = !state.file;
  }
}

function acceptFile(file) {
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    setStatus('이미지 파일만 올려 주세요.', 'bad');
    return;
  }

  state.file = file;
  state.rotation = 0;
  setStatus('사진이 준비됐어요.');
  refreshPreview();
}

async function runOcr() {
  const btn = $('read');
  btn.disabled = true;
  setStatus('사진을 준비하는 중이에요…', 'busy');

  try {
    const image = state.prepared || await prepareImage(state.file, state.rotation);

    setStatus('사진의 글씨를 읽는 중이에요…', 'busy');

    const form = new FormData();
    form.append('image', image);

    const data = await callApi(form);
    const text = (data.text || '').trim();

    if (!text) {
      setStatus('글씨를 찾지 못했어요. 더 밝은 곳에서 다시 찍어 볼까요?', 'bad');
      return;
    }

    state.text = text;
    goto(1);
  } catch (error) {
    setStatus(error.message, 'bad');
  } finally {
    if ($('read')) $('read').disabled = !state.file;
  }
}

/* ─────────────────────────────────────────── 2단계: 원문 확정 */

function screenConfirm() {
  $('app').innerHTML =
    '<section class="card">' +
    '<p class="eyebrow">2단계</p>' +
    '<h2>이렇게 읽었어요. 맞나요?</h2>' +
    '<p class="lede">잘못 읽은 글자가 있으면 고쳐 주세요. <b>맞춤법이 틀린 곳은 그대로 두세요</b> — 그걸 찾는 게 이번 공부예요.</p>' +
    '<textarea class="sheet" id="src" spellcheck="false" aria-label="읽은 글 확인"></textarea>' +
    '<p class="status" id="status"></p>' +
    '<div class="actions">' +
    '<button class="btn btn-go" id="ok">이 글이 맞아요</button>' +
    '<button class="btn btn-quiet" id="back">사진 다시 고르기</button>' +
    '</div>' +
    '</section>';

  $('src').value = state.text;

  $('ok').onclick = () => {
    const text = $('src').value.trim();

    if (!text) { setStatus('글을 확인해 주세요.', 'bad'); return; }

    state.text = text;
    state.log = [];
    goto(2);
  };

  $('back').onclick = () => goto(0);
}

/* ─────────────────────────────────────────── 3단계: 미션 */

function screenMission(mission) {
  const name = MISSION_NAMES[mission];

  $('app').innerHTML =
    '<section class="card">' +
    '<p class="eyebrow">미션 ' + mission + ' / ' + LAST_MISSION + '</p>' +
    '<h2>' + escapeHtml(name) + ' 미션</h2>' +
    '<p class="lede" id="lede">고칠 곳을 찾는 중이에요…</p>' +
    '<ul class="items" id="items"></ul>' +
    '<p class="status" id="status"></p>' +
    '<div class="actions" id="actions"></div>' +
    '</section>';

  loadMission(mission);
}

async function loadMission(mission) {
  setStatus('고칠 곳을 찾는 중이에요…', 'busy');

  try {
    const data = await callApi({ mode: 'find', text: state.text, mission });

    state.items = data.items || [];
    state.kind = data.kind || 'word';

    if (state.items.length === 0) {
      $('lede').textContent = '이번 미션에서 고칠 곳이 없어요. 아주 잘 썼네요!';
      setStatus('');
      $('actions').innerHTML = '<button class="btn btn-go" id="next">다음으로</button>';
      $('next').onclick = () => goto(state.step + 1);
      return;
    }

    renderItems(mission);
  } catch (error) {
    $('lede').textContent = '';
    setStatus(error.message, 'bad');
    $('actions').innerHTML = '<button class="btn btn-quiet" id="retry">다시 시도</button>';
    $('retry').onclick = () => loadMission(mission);
  }
}

function renderItems(mission) {
  const sentence = state.kind === 'sentence';

  $('lede').textContent = sentence
    ? '아래 문장을 자연스럽게 다시 써 볼까요?'
    : '왼쪽이 고칠 말이에요. 오른쪽 칸에 바르게 써 보세요.';

  $('items').innerHTML = state.items.map((it, i) => {
    const hint = it.hint
      ? '<div class="hint"><b>힌트</b> · ' + escapeHtml(it.hint) + '</div>'
      : '';

    if (sentence) {
      const shown = wrap(it.wrong, [it.mark], '<u>', '</u>');

      return '<li class="item" data-i="' + i + '">' +
        '<p class="sentence">' + shown + '</p>' +
        '<input class="fix-line" type="text" autocomplete="off" spellcheck="false"' +
        ' placeholder="이 문장을 다시 써 보세요" aria-label="문장 고쳐 쓰기">' +
        hint +
        '<p class="verdict" hidden></p>' +
        '</li>';
    }

    const ctx = it.ctx
      ? '<p class="item-ctx">' + wrap(it.ctx, [it.wrong], '<mark>', '</mark>') + '</p>'
      : '';

    return '<li class="item" data-i="' + i + '">' +
      ctx +
      '<div class="pair">' +
      '<span class="wrong">' + escapeHtml(it.wrong) + '</span>' +
      '<span class="arrow" aria-hidden="true">→</span>' +
      '<input class="fix" type="text" autocomplete="off" spellcheck="false"' +
      ' placeholder="바르게 고쳐 쓰기" aria-label="' + escapeHtml(it.wrong) + ' 고쳐 쓰기">' +
      '</div>' +
      hint +
      '<p class="verdict" hidden></p>' +
      '</li>';
  }).join('');

  setStatus('');

  $('actions').innerHTML =
    '<button class="btn btn-go" id="check">확인하기</button>' +
    '<button class="btn btn-quiet" id="reveal">모르겠어요</button>';

  $('check').onclick = () => submit(mission, false);
  $('reveal').onclick = () => submit(mission, true);
}

function collectAnswers() {
  return state.items.map((it, i) => {
    const li = document.querySelector('.item[data-i="' + i + '"]');
    const input = li ? li.querySelector('.fix, .fix-line') : null;

    return { wrong: it.wrong, input: input ? input.value.trim() : '' };
  });
}

function setButtons(disabled) {
  ['check', 'reveal'].forEach((id) => { if ($(id)) $(id).disabled = disabled; });
}

async function submit(mission, reveal) {
  const answers = collectAnswers();

  if (!reveal && answers.every((a) => !a.input)) {
    setStatus('먼저 고쳐 써 볼까요?', 'bad');
    return;
  }

  setButtons(true);
  setStatus(reveal ? '정답을 알려 줄게요…' : '아빠가 읽어 보는 중이에요…', 'busy');

  try {
    const data = await callApi({
      mode: 'grade', text: state.text, mission, answers, reveal
    });

    applyResults(data.results || [], mission, reveal);
  } catch (error) {
    setStatus(error.message, 'bad');
  } finally {
    setButtons(false);
  }
}

function applyResults(results, mission, reveal) {
  let allDone = true;

  results.forEach((r, i) => {
    const li = document.querySelector('.item[data-i="' + i + '"]');
    if (!li) return;

    const input = li.querySelector('.fix, .fix-line');
    const out = li.querySelector('.verdict');
    const settled = r.ok || reveal;

    if (reveal && !r.ok && r.answer) input.value = r.answer;

    li.dataset.state = r.ok ? 'ok' : 'miss';
    out.dataset.kind = r.ok ? 'ok' : 'miss';
    out.hidden = false;

    if (r.ok) {
      out.innerHTML = '<b>맞았어요</b><span>' + escapeHtml(r.why || '') + '</span>';
    } else if (reveal) {
      out.innerHTML = '<b>정답</b><span>' +
        escapeHtml(r.answer || '') + ' — ' + escapeHtml(r.why || '') + '</span>';
    } else {
      out.innerHTML = '<b>다시</b><span>거의 다 왔어요. 힌트를 한 번 더 볼까요?</span>';
      allDone = false;
    }

    if (settled) {
      input.readOnly = true;

      const answer = r.answer || r.input;

      if (answer && !state.log.some((l) => l.wrong === r.wrong)) {
        state.log.push({
          wrong: r.wrong,
          answer,
          why: r.why || '',
          tag: MISSION_NAMES[mission]
        });
      }
    }
  });

  if (!allDone) {
    setStatus('아직 남았어요. 고쳐서 다시 확인해 보세요.', 'bad');
    return;
  }

  setStatus('');

  const last = mission >= LAST_MISSION;

  $('actions').innerHTML =
    '<button class="btn btn-go" id="next">' + (last ? '결과 보기' : '다음 미션으로') + '</button>';

  $('next').onclick = () => goto(state.step + 1);
}

/* ─────────────────────────────────────────── 완료 */

function screenDone() {
  const after = buildAfter(state.text, state.log);

  const beforeHtml = paint(state.text, state.log.map((l) => l.wrong), 'was');
  const afterHtml = paint(after, state.log.map((l) => l.answer), 'now');

  const changes = state.log.length
    ? state.log.map((l) =>
        '<li class="change">' +
        '<span class="change-w"><s>' + escapeHtml(l.wrong) + '</s> → <em>' +
        escapeHtml(l.answer) + '</em></span>' +
        '<span class="change-tag">' + escapeHtml(l.tag) + '</span>' +
        '<span class="change-why">' + escapeHtml(l.why) + '</span>' +
        '</li>').join('')
    : '<li class="change"><span class="change-w">고친 곳 없음</span>' +
      '<span class="change-why">맞춤법도 띄어쓰기도 문장도 자연스러웠어요.</span></li>';

  $('app').innerHTML =
    '<section class="card">' +
    '<p class="eyebrow">완료</p>' +
    '<h2>오늘 이만큼 고쳤어요</h2>' +
    '<div class="score"><b>' + state.log.length + '</b><span>군데를 바르게 고쳤습니다</span></div>' +
    '<div class="compare">' +
    '<div class="pane"><i>처음 쓴 글</i>' + beforeHtml + '</div>' +
    '<div class="pane"><i>고친 글</i>' + afterHtml + '</div>' +
    '</div>' +
    '<h3 style="margin-top:1.6rem">무엇을 어떻게 고쳤나요?</h3>' +
    '<ul class="changes">' + changes + '</ul>' +
    '<div class="actions"><button class="btn btn-go" id="again">새 일기 점검하기</button></div>' +
    '</section>';

  $('again').onclick = () => {
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.file = null;
    state.prepared = null;
    state.rotation = 0;
    state.previewUrl = null;
    state.text = '';
    state.items = [];
    state.log = [];
    goto(0);
  };
}

render();
