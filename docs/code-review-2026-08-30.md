# happy-learning-diary 코드 검증 및 수정 기록

- 일자: 2026-08-30
- 저장소: https://github.com/acejmh/happy-learning-diary
- 검증 시점 커밋: `9c6a361` (Initial commit via Netlify)
- 수정 커밋: `de1c437` → main 머지 완료 (PR #1, `599ca2b`)
- 배포처 전환: `4f7b50b` (Cloudflare → Vercel, 아래 5장)

---

## 0. 가장 먼저 확인한 사실 — 이관은 일어나지 않았다

| 확인 항목 | 결과 |
|---|---|
| 커밋 히스토리 | 1개. `"Initial commit via Netlify [skip ci]"` |
| 저장소 생성 시각 | 2026-08-30 13:48:41Z |
| `has_pages` | `false` |
| `acejmh.github.io/happy-learning-diary/` | HTTP 404 |
| `happy-learning-diary.netlify.app/` | **HTTP 200 (여전히 가동 중)** |

이 저장소는 사람이 옮긴 것이 아니라 **Netlify 연동이 자동 생성해 푸시한 소스 백업**이다.
GitHub Pages 는 켜져 있지 않고 `.github/workflows/` 도 없다.
앱은 검증 시점에도 Netlify 에서 돌고 있었고, 사용량 제한 문제는 해소되지 않은 상태였다.

### GitHub Pages 는 이 앱의 이관 대상이 될 수 없다

앱 기능이 사실상 전부 서버 함수(`netlify/functions/analyze.js`)에 있다.
사진 OCR 도 첨삭 판정도 서버를 거친다. Pages 는 정적 파일만 서빙하므로
`fetch('/.netlify/functions/analyze')` 가 전부 404 가 되고 첫 단계에서 멈춘다.

우회하려고 Gemini 키를 프론트엔드에 넣으면 즉시 공개된다.
→ **서버 함수가 도는 곳으로 가야 한다. Cloudflare Workers 를 선택했다.**

---

## 1. 보안 점검 결과

### 커밋된 비밀정보: 없음 ✅

전체 히스토리를 `AIza…` / `sk-…` / `nfp_…` / `ghp_…` / PRIVATE KEY 패턴으로 스캔 → **검출 0건**.
키는 `process.env.GEMINI_API_KEY` 로만 읽고 있었다. Public 전환은 안전했다.

### 발견된 실제 위험: 인증 없는 공개 Gemini 프록시 🔴

실측 (2026-08-30):

```
GET  /.netlify/functions/analyze     → 405 {"error":"POST 요청만 허용됩니다."}
POST /.netlify/functions/analyze {}  → 400 {"error":"원문이 없습니다."}
```

살아 있고 누구나 호출 가능했다. 인증·레이트리밋·Origin 검사·입력 길이 제한이 전부 없었다.
`original`/`answer` 에 아무 텍스트나 넣어 POST 하면 **소유자의 Gemini 키로 과금되는 LLM 호출**이 된다.

→ 처음에는 이것이 Netlify 사용량 제한의 원인이라고 추정했으나, **실측 결과 아니었다.** 아래 참조.

### Netlify 쿼터가 터진 진짜 원인: 배포 횟수 (대시보드 실측)

| 항목 | 소비 | 비중 |
|---|---|---|
| **Production deploys (20회)** | **300 credits** | **99.7%** |
| Compute | 0.7 credits | |
| Web requests (451건) | 0.1 credits | |
| Bandwidth | < 1 credit | |
| AI inference | 0 credits | |
| **합계** | **300.8 credits** | |

**배포 1회 = 15 credits.** 개발하면서 20번 배포한 것이 쿼터 전부를 태웠다.
트래픽은 전체의 0.27% 에 불과했고 요청도 451건뿐이라 **남용 흔적은 없었다.**

이 사실이 Cloudflare 이관을 더 확실한 정답으로 만든다.
**Cloudflare Workers 는 배포 횟수에 과금하지 않는다** (무료 플랜 배포 무제한, 요청 하루 10만 건).

잔여 `29.2 / 30 operational credits` 는 *배포에는 쓸 수 없는* 잔액이다
(이미 배포된 사이트를 살려 두는 용도). 즉 **현재 Netlify 에 새 배포가 불가능하다.**

> 레이트리밋을 넣은 것은 그래도 유효하다. 그것이 지키는 것은 Netlify 요금이 아니라
> **Google Gemini 요금**이고, 그건 별개의 청구서다.

---

## 2. 발견된 기능 결함

### 🔴 미션 2·3 이 무의미해지는 로직 결함

원래 프롬프트(`analyze.js:374`)가 Gemini 에게 요구한 것:

> "corrected 에는 전체 문장을 자연스럽게 고친 최종본을 작성합니다."

즉 맞춤법뿐 아니라 띄어쓰기·조사까지 전부 고친 완성본이 돌아온다.
그런데 클라이언트(`app.js:17`)가 그것을 그대로 받아 다음 미션의 입력으로 썼다.

```js
if(d.pass){ ... currentText = d.corrected || a; if(mission<3){mission++; renderMission()} ... }
```

**미션 1(맞춤법)을 통과하는 순간 문장이 전부 교정된 상태가 된다.**
미션 2(띄어쓰기), 미션 3(조사)에는 고칠 것이 남지 않는다.
3단계 학습 설계가 1단계에서 끝나 버린다.

### 🔴 사진이 약 4.5MB 를 넘으면 실패

Netlify 동기 함수의 버퍼 페이로드 상한은 **6MB**. 바이너리는 base64 로 약 33% 커지므로
**실효 상한이 약 4.5MB**. 요즘 스마트폰 사진(3~8MB)이 정면으로 걸린다.
클라이언트에 리사이즈·압축이 전혀 없었다.

게다가 상한 초과 시 응답이 JSON 이 아닐 수 있는데 `app.js:9` 는 `await r.json()` 을 무조건 호출했다.
아이 화면에 `인식에 실패했어요: Unexpected token '<'...` 같은 메시지가 뜬다.

### 🟡 완료 화면 하이라이트 버그 2건 (재현 완료)

`app.js:20` 의 `highlight()` 가 **이스케이프된 문자열에 정규식을 다시 돌렸다.**

재현 결과:

```
입력:  before "I don't know"  /  after "I don't understand"
출력:  I don&#<span class="highlight">039</span>;t understand
       → 화면에 &#039; 가 그대로 노출됨
```

`"`, `'`, `&` 가 든 문장에서 `&quot;` `&#039;` `&amp;` 가 깨져 노출된다.
초등 일기에 큰따옴표(대화문)는 흔하므로 실제로 자주 발생한다.

두 번째 — **띄어쓰기 교정은 절대 하이라이트되지 않았다:**

```
전: 오늘 수학시간에 곱셈을 배웠다
후: 오늘 수학 시간에 곱셈을 배웠다
결과: 하이라이트 0개
```

`a.indexOf('수학')`, `a.indexOf('시간에')` 둘 다 원문에서 발견되기 때문.
**미션 2 의 성과가 완료 화면에 전혀 보이지 않았다.**

### 🟡 `feedback` 만 이스케이프 누락

```js
function show(t,ok){ $('fb').innerHTML = `<div class="${...}">${t}</div>` }   // app.js:18
```

`t` 에 Gemini 생성 텍스트가 이스케이프 없이 들어갔다. 다른 곳은 전부 `escape()` 를 거치는데 여기만 빠졌다.
Gemini 출력은 사용자가 올린 사진의 OCR 에서 파생되므로 **이미지 → 프롬프트 인젝션 → HTML 삽입** 경로가 열려 있었다.

### 🟢 그 밖

- 완료 화면 "전" 이 아이가 확정한 글이 아니라 원본 OCR 이었다 (2단계 수정이 반영 안 됨)
- `show(t, true)` 가 한 번도 호출되지 않아 **칭찬 피드백이 화면에 뜨는 경로가 없었다**. 초록 `.feedback` 스타일은 죽은 코드
- 인식 성공 후 `readBtn` 이 disabled 로 남아 재시도 불가 (새로고침 필요)
- `URL.createObjectURL` 미해제
- `mode:'check'` 필드를 보내지만 서버가 사용하지 않음
- `package.json` 에 name/version 없음, lockfile·`.gitignore` 없음
- 모델 `gemini-3.6-flash` 는 유효한 현행 stable. 다만 이전 세대 (최신은 `gemini-3.7-flash`)

---

## 3. 적용한 수정

### 구조 — 한 벌의 로직으로 두 플랫폼

Netlify Functions v2 와 Cloudflare Workers 는 **둘 다 Web 표준 `fetch` 시그니처**를 쓴다.
그래서 핵심 로직을 `src/` 로 분리하고 어댑터만 각 플랫폼에 두었다.

```
public/          index.html, app.js, style.css
src/analyze.js   요청 라우팅 + 검증
src/gemini.js    Gemini 호출
src/prompts.js   OCR / 첨삭 프롬프트
src/guard.js     Origin 검사 · 일일 상한 · 입력 크기 상한
worker/index.js               Cloudflare 어댑터 (39줄)
netlify/functions/analyze.mjs Netlify 어댑터 (22줄)
test/                         네트워크·키 없이 도는 검증 25개
```

클라이언트는 항상 `/api/analyze` 만 호출한다.
**호스팅을 옮겨도 프론트엔드는 손댈 필요가 없다.**

### 남용 방지 (3중)

1. **Origin 검사** — 브라우저는 same-origin POST 에도 `Origin` 헤더를 붙인다. `curl` 직접 호출은 헤더가 없어 403
2. **일일 상한** — IP 당 60회 / 전체 500회, KST 자정 초기화. Cloudflare 는 KV 로 인스턴스 간 공유
3. **입력 크기 상한** — 사진 4MB, 글 4000자

추가로 API 키를 쿼리스트링이 아닌 `x-goog-api-key` 헤더로 보내고(로그·리퍼러 잔존 방지),
상류 오류 메시지와 JSON 파싱 실패 raw 를 클라이언트로 흘리지 않게 했다.

### 미션 로직

`corrected` 를 **"이번 미션 범위의 오류만 고친 문장"** 으로 프롬프트에서 강제.
범위 밖 오류는 *일부러 그대로 두라*고 명시했다. 다음 단계에서 아이가 고칠 부분이기 때문.

### 클라이언트

- 업로드 전 **긴 변 1600px / JPEG 0.8 리사이즈**. 페이로드 상한 회피 + 함수 실행 시간(=사용량) 감소
- 하이라이트를 **단어 단위 LCS diff** 로 교체. 이스케이프를 diff **뒤에** 적용
- `feedback` 이스케이프 보완, 비-JSON 응답 안전 처리
- 재시도 가능, objectURL 해제, 미션 전환 중 중복 요청 차단, 칭찬 피드백 표시
- `busboy` 제거 (`request.formData()` 로 대체) → **의존성 0개**

### 검증

```
npm test  →  25 passing / 0 failing
```

하이라이트 엔티티 파손, 띄어쓰기 diff, Origin 차단, 일일 상한, 4MB 초과 413,
상류 키 문자열 노출 차단 등을 회귀 테스트로 고정했다.

---

## 4. 남은 일

| # | 할 일 | 상태 |
|---|---|---|
| 1 | Netlify 쿼터 원인 규명 | ✅ 완료 — 배포 20회가 99.7% |
| 2 | 브랜치 push 및 main 머지 (PR #1) | ✅ 완료 — `599ca2b` |
| 3 | Cloudflare Workers 배포 | ⚠️ 배포는 성공했으나 Gemini 지역 제한으로 폐기 → 5장 |
| 4 | Vercel 배포 (GitHub 연동) | ⬜ 본인 진행 |

상세 배포 절차는 저장소의 `README.md` 참고.

### 현재 가동 상태 (2026-08-30 실측)

main 에 머지됐지만 **Netlify 는 배포 credit 이 없어 재배포되지 않았다.**

```
happy-learning-diary.netlify.app/app.js  → 구버전 코드 (netlify/functions 참조 2건)
                              /api/analyze → 404
```

즉 **라이브 사이트는 여전히 옛 코드**이고, 위의 결함들이 그대로 살아 있다.
새 코드는 GitHub main 에만 있고 아직 어디에도 배포되지 않았다.
실패한 배포는 이전 배포를 그대로 유지하므로 사이트가 깨지지는 않았다.

→ **Cloudflare 배포가 곧 "고친 코드를 실제로 띄우는" 단계다.**

### 주의 — 프롬프트를 다시 손볼 때

`corrected` 가 "이번 미션 범위만" 이라는 제약을 깨면 미션 2·3 이 다시 무의미해진다.
`src/prompts.js` 의 `[이번 미션에서 보지 않을 것]` 블록이 그 장치다.

---

## 5. 배포처 전환 — Cloudflare Workers 는 이 앱에 쓸 수 없다

Cloudflare Workers 배포는 **정상적으로 완료됐다.** 정적 에셋 업로드, KV 바인딩,
시크릿 등록, Origin 검사, 레이트리밋까지 전부 확인했다.

```
GET  /              → 200 (신규 코드 서빙)
POST /api/analyze   → 403  Origin 없는 직접 호출 차단
POST /api/analyze   → 403  타 origin 차단
```

그러나 실제 Gemini 호출에서 막혔다. `wrangler tail` 로 잡은 상류 메시지:

```
Gemini API error: User location is not supported for the API use.
```

### 원인

Google 은 **요청 IP 로 지역을 판정**하는데, Cloudflare Workers 는 요청을 처리한
엣지 데이터센터에서 아웃바운드가 나간다. Google 이 그 IP 를 지원 지역으로 인식하지 못한다.

Netlify 에서 되던 이유는 함수가 **AWS 고정 리전**에서 돌았기 때문이다.
Enterprise 플랜이 아니면 Workers 실행 리전을 고정할 수 없다. 널리 보고된 이슈다.

- https://github.com/google/generative-ai-js/issues/37
- https://github.com/google-gemini/generative-ai-js/issues/151
- https://community.cloudflare.com/t/do-not-put-workers-in-llm-forbidden-locations/711754/1

> 참고: **로컬 실행(`wrangler dev`)은 문제없다.** 아웃바운드가 엣지가 아니라
> 내 PC 에서 나가기 때문이다. 지역 제한은 배포했을 때만 드러난다.
> 로컬에서만 테스트하면 못 잡는 함정이다.

### 해결 — Vercel

Vercel Node.js 런타임은 Cloudflare Workers 와 **동일한 Web 표준 fetch export**
형식을 쓴다. `src/` 를 그대로 재사용하고 어댑터 14줄만 추가했다.

```
api/analyze.js   Vercel 어댑터
vercel.json      outputDirectory=public, regions=["iad1"], 보안 헤더
```

`regions: ["iad1"]` (미국 동부) **리전 고정이 지역 제한을 피하는 핵심**이므로 지우면 안 된다.

Vercel Hobby 는 무료이고 **배포 횟수 제한이 없다.**
Netlify 를 떠나게 만든 배포 크레딧 문제도 함께 해결된다.

`worker/` 와 `wrangler.toml` 은 삭제하지 않고 남겼다.
지역 제한이 풀리면 KV 기반 일일 상한이 더 정확하므로 돌아갈 여지가 있다.

### 남용 방지의 실제 강도 (정직하게)

- **Origin 검사는 인증이 아니다.** 검증 중 curl 에 `Origin` 헤더를 직접 붙여 통과시켰다.
  주소를 아는 사람은 뚫는다. 브라우저 기반 오·남용과 무심코 긁는 봇을 막는 수준이다.
- **일일 상한이 실질적인 방어선**이지만, Vercel/Netlify 에서는 인스턴스 로컬 카운터라
  완전하지 않다 (Cloudflare 는 KV 로 공유되어 정확했다).
- 실제로 남용이 관측되면 Cloudflare Turnstile 같은 것을 붙여야 한다.
  현재 트래픽(총 451건)을 보면 아직 과한 대응이다.

---

## 6. 운영 방식 — 로컬 파일 없이

회사 PC 에 개인 프로젝트 파일을 두지 않기로 했다. 코드는 전부 GitHub 에 있고,
**Vercel 을 GitHub 에 연동해 push = 배포**로 만든다. 로컬 클론이 필요 없다.

수정은 GitHub 웹 에디터에서 한다 (파일 화면의 연필 아이콘, 또는 리포에서 `.` 키).
파일 16개에 빌드도 없는 프로젝트라 이걸로 충분하다.

### 아직 남은 정리

| 대상 | 상태 |
|---|---|
| Cloudflare 워커 (키 포함, 배포된 상태) | Vercel 확인 후 `wrangler delete` |
| Netlify 사이트 (옛 코드, 무방비 프록시) | Vercel 확인 후 삭제 |
| 옛 Gemini 키 (Netlify 에 있던 것) | Netlify 삭제와 함께 AI Studio 에서 폐기 |

옛 키를 지우는 순간 무방비 상태였던 옛 엔드포인트가 완전히 무력화된다.
