'use strict';

/* 플랫폼 중립 경로. Netlify 는 netlify.toml 리다이렉트로,
   Cloudflare 는 worker/index.js 라우팅으로 같은 곳에 붙는다. */
const API_URL = '/api/analyze';

/* 업로드 전 리사이즈 기준.
   Netlify 동기 함수의 버퍼 페이로드 상한은 6MB 이고 base64 로 약 33% 커지므로
   실효 상한이 4.5MB 정도다. 요즘 폰 사진(3~8MB)은 그대로 보내면 걸린다.
   긴 변 1600px / JPEG 0.8 이면 OCR 정확도는 유지되면서 대개 300KB 안쪽으로 떨어진다. */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.8;
const TOTAL_MISSIONS = 3;

const $ = (id) => document.getElementById(id);

let selectedFile = null;
let previewUrl = null;
let confirmedText = '';   // 아이가 "이 글이 맞아요"로 확정한 원본
let currentText = '';     // 미션을 거치며 갱신되는 현재 글
let mission = 0;
const corrections = [];

/* ---------------------------------------------------------------- 유틸 */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[c]));
}

/** 응답이 JSON 이 아닐 수도 있다(413, 502, 프록시 HTML 등). 절대 터지지 않게 읽는다. */
async function readJson(response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return {
      error: '서버가 예상치 못한 응답을 보냈어요. (HTTP ' + response.status + ')'
    };
  }
}

/* --------------------------------------------------- 단어 단위 diff 하이라이트 */

/** 공백도 토큰으로 유지한다. 그래야 띄어쓰기 교정이 diff 에 잡힌다. */
function tokenize(text) {
  return String(text).match(/\s+|\S+/g) || [];
}

/** 최장 공통 부분수열. after 쪽에서 그대로 살아남은 토큰 위치를 표시해 돌려준다. */
function lcsKeepMask(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const keep = new Array(m).fill(false);
  let i = 0;
  let j = 0;

  while (i < n && j < m) {
    if (a[i] === b[j]) {
      keep[j] = true;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  return keep;
}

/**
 * before 대비 after 에서 새로 생긴 부분만 하이라이트한다.
 *
 * 이스케이프를 diff **뒤에** 적용하는 것이 핵심이다.
 * 먼저 이스케이프하면 &quot; &#039; 같은 엔티티 안쪽 글자에 정규식이 걸려
 * 화면에 &quot; 가 그대로 노출된다.
 */
function highlightDiff(before, after) {
  const a = tokenize(before);
  const b = tokenize(after);
  const keep = lcsKeepMask(a, b);

  let html = '';
  let buffer = '';
  let bufferChanged = false;

  const flush = () => {
    if (!buffer) return;
    html += bufferChanged
      ? '<span class="highlight">' + escapeHtml(buffer) + '</span>'
      : escapeHtml(buffer);
    buffer = '';
  };

  b.forEach((token, index) => {
    const changed = !keep[index];

    // 바뀐 토큰끼리는 묶어서 하나의 하이라이트로 보여 준다.
    if (changed !== bufferChanged) {
      flush();
      bufferChanged = changed;
    }

    buffer += token;
  });

  flush();

  return html;
}

/* ------------------------------------------------------------ 사진 리사이즈 */

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('사진을 열 수 없어요.'));
    };

    img.src = url;
  });
}

/** 긴 변을 MAX_EDGE 로 줄이고 JPEG 로 다시 인코딩한다. 이미 작으면 원본을 그대로 쓴다. */
async function shrinkImage(file) {
  const img = await loadImage(file);
  const longEdge = Math.max(img.naturalWidth, img.naturalHeight);

  if (longEdge <= MAX_EDGE && file.size <= 1500000) {
    return file;
  }

  const scale = Math.min(1, MAX_EDGE / longEdge);
  const canvas = document.createElement('canvas');

  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);

  const ctx = canvas.getContext('2d');

  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY)
  );

  if (!blob) return file;

  // 줄인 게 더 크면(작은 PNG 등) 원본을 쓴다.
  return blob.size < file.size
    ? new File([blob], 'photo.jpg', { type: 'image/jpeg' })
    : file;
}

/* ------------------------------------------------------------ 1단계: 업로드 */

const fileInput = $('file');
const drop = $('drop');
const preview = $('preview');
const readBtn = $('readBtn');

function setReadStatus(message) {
  $('readStatus').textContent = message;
}

function acceptFile(f) {
  if (!f) return;

  if (!f.type.startsWith('image/')) {
    setReadStatus('이미지 파일만 올려 주세요.');
    return;
  }

  selectedFile = f;

  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(f);

  preview.src = previewUrl;
  preview.style.display = 'block';
  readBtn.disabled = false;
  setReadStatus('사진이 준비됐어요.');
}

fileInput.onchange = (e) => acceptFile(e.target.files[0]);

['dragenter', 'dragover'].forEach((type) =>
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.style.background = '#eaf4ff';
  })
);

['dragleave', 'drop'].forEach((type) =>
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.style.background = '';
  })
);

drop.addEventListener('drop', (e) => acceptFile(e.dataTransfer.files[0]));

readBtn.onclick = async () => {
  readBtn.disabled = true;
  setReadStatus('사진을 준비하는 중이에요…');

  try {
    const image = await shrinkImage(selectedFile);

    setReadStatus('사진의 글씨를 읽는 중이에요…');

    const form = new FormData();
    form.append('image', image);

    const response = await fetch(API_URL, { method: 'POST', body: form });
    const data = await readJson(response);

    if (!response.ok) throw new Error(data.error || '인식에 실패했어요.');

    const text = data.text || '';

    $('sourceText').value = text;
    $('sourceText').disabled = false;
    $('confirmBtn').disabled = !text.trim();

    setReadStatus(
      text.trim()
        ? '인식이 끝났어요. 원본 글과 맞는지 확인해 주세요.'
        : '글씨를 찾지 못했어요. 더 밝은 곳에서 다시 찍어 볼까요?'
    );
  } catch (error) {
    setReadStatus('인식에 실패했어요: ' + error.message);
  } finally {
    // 실패해도 성공해도 다시 시도할 수 있어야 한다.
    readBtn.disabled = !selectedFile;
  }
};

/* ------------------------------------------------------- 2단계: 원문 확정 */

$('confirmBtn').onclick = () => {
  const text = $('sourceText').value.trim();

  if (!text) {
    setReadStatus('글을 확인해 주세요.');
    return;
  }

  confirmedText = text;
  currentText = text;
  mission = 1;

  $('title').textContent = '내가 쓴 글을 차근차근 고쳐 봐요.';
  $('status').textContent = '정답을 직접 고친 뒤 다음으로 넘어가요.';

  renderMission();
};

/* ---------------------------------------------------------- 3단계: 미션 */

const MISSIONS = [
  ['맞춤법 미션', '문장에서 맞춤법이 어색한 부분을 찾아 바르게 고쳐 보세요.', '예: 재미있엇다 → 재미있었다'],
  ['띄어쓰기 미션', '붙어 있는 말을 알맞게 띄어 써 보세요.', '예: 두개 → 두 개, 배운점 → 배운 점'],
  ['조사·문맥 미션', '누가 무엇을 했는지 잘 드러나도록 조사와 문장 연결을 고쳐 보세요.', '예: 나는 과학 실험 재미있었다 → 나는 과학 실험이 재미있었다.']
];

function renderMission() {
  const [name, description, hint] = MISSIONS[mission - 1];

  $('step').textContent = mission + ' / ' + TOTAL_MISSIONS;
  $('bar').style.width = (mission / TOTAL_MISSIONS) * 100 + '%';

  $('app').innerHTML =
    '<div class="ocr"><b>현재 글</b><br>' + escapeHtml(currentText) + '</div>' +
    '<div class="mission">' +
    '<h2>미션 ' + mission + ' · ' + name + '</h2>' +
    '<p>' + description + '</p>' +
    '<div class="hint">' + hint + '</div>' +
    '<textarea id="answer" placeholder="고친 문장을 전체로 써 보세요."></textarea>' +
    '<button class="primary" id="check">답변 확인하기</button>' +
    '<div id="fb"></div>' +
    '</div>';

  // 값은 innerHTML 이 아니라 프로퍼티로 넣는다(이스케이프 이슈 원천 차단).
  $('answer').value = currentText;
  $('check').onclick = check;
}

function showFeedback(message, ok) {
  $('fb').innerHTML =
    '<div class="' + (ok ? 'feedback' : 'hint') + '">' + escapeHtml(message) + '</div>';
}

async function check() {
  const answer = $('answer').value.trim();

  if (answer.length < 5) {
    showFeedback('짧은 답변이에요. 문장 전체를 써 보세요.', false);
    return;
  }

  // 다음 미션으로 넘어가는 중이면 버튼을 다시 켜지 않는다.
  // (900ms 대기 동안 다시 눌러 중복 요청이 나가는 것을 막는다.)
  let advancing = false;

  $('check').disabled = true;
  showFeedback('선생님이 읽어 보는 중이에요…', false);

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ original: currentText, answer: answer, mission: mission })
    });

    const data = await readJson(response);

    if (!response.ok) {
      showFeedback(data.error || '점검에 실패했어요. 다시 시도해 주세요.', false);
      return;
    }

    if (!data.pass) {
      showFeedback(data.feedback || '문장의 뜻과 흐름을 다시 살펴보세요.', false);
      return;
    }

    corrections.push(...(data.corrections || []));

    /* corrected 는 이번 미션 범위만 고친 문장이다(프롬프트에서 그렇게 강제한다).
       다음 미션에서 고칠 거리가 남아 있어야 3단계 학습이 성립한다. */
    currentText = data.corrected || answer;

    if (mission < TOTAL_MISSIONS) {
      advancing = true;
      showFeedback(data.feedback || '잘했어요! 다음 미션으로 갈게요.', true);
      mission++;
      setTimeout(renderMission, 900);
      return;
    }

    advancing = true;
    finish(data.feedback);
  } catch (error) {
    showFeedback('서버에 연결할 수 없어요: ' + error.message, false);
  } finally {
    if (!advancing && $('check')) $('check').disabled = false;
  }
}

/* ------------------------------------------------------------ 완료 화면 */

function finish(lastFeedback) {
  $('step').textContent = '완료';
  $('bar').style.width = '100%';
  $('title').textContent = '점검이 끝났어요!';
  $('status').textContent = '전·후 문장과 고친 이유를 확인해 보세요.';

  const list = corrections.length
    ? corrections
        .map((c) =>
          '<li><b>' + escapeHtml(c.before) + '</b> → <b>' + escapeHtml(c.after) +
          '</b><br>' + escapeHtml(c.reason) + '</li>'
        )
        .join('')
    : '<li>고친 부분이 없어요. 맞춤법과 띄어쓰기가 자연스러워요.</li>';

  const praise = lastFeedback
    ? '<div class="feedback">' + escapeHtml(lastFeedback) + '</div>'
    : '';

  $('app').innerHTML =
    '<div class="mission">' +
    '<h2>완료 🎉</h2>' +
    '<p>처음 쓴 글과 고친 글을 비교해 보세요.</p>' +
    praise +
    '<div class="compare">' +
    '<div><b>전</b><br>' + escapeHtml(confirmedText) + '</div>' +
    '<div><b>후</b><br>' + highlightDiff(confirmedText, currentText) + '</div>' +
    '</div>' +
    '<h3>무엇을 고쳤나요?</h3>' +
    '<ul>' + list + '</ul>' +
    '</div>' +
    '<button class="primary" id="restart">새 글 점검하기</button>';

  $('restart').onclick = () => location.reload();
}
