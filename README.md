# 배움일기 맞춤법·문맥 코치

초등학생이 쓴 배움일기 사진을 올리면, 글씨를 읽어 주고 맞춤법 → 띄어쓰기 → 조사·문맥
3단계 미션으로 스스로 고쳐 보게 하는 웹앱.

## 구조

```
public/           정적 파일 (index.html, app.js, style.css)
src/              플랫폼 무관 핵심 로직
  analyze.js        요청 라우팅 + 검증 (Web 표준 Request/Response)
  gemini.js         Gemini 호출
  prompts.js        OCR / 첨삭 프롬프트
  guard.js          Origin 검사 · 일일 상한 · 입력 크기 상한
worker/index.js   Cloudflare Workers 어댑터
netlify/functions/analyze.mjs   Netlify Functions v2 어댑터
test/             네트워크 없이 도는 검증 (npm test)
```

Netlify Functions v2 와 Cloudflare Workers 는 **둘 다 Web 표준 `fetch` 시그니처**를 쓴다.
그래서 `src/` 하나를 양쪽이 공유하고, 어댑터는 각각 10줄 남짓이다.
클라이언트는 항상 `/api/analyze` 만 호출하므로 **호스팅을 옮겨도 프론트엔드는 손댈 필요가 없다.**

> ⚠️ **GitHub Pages 에는 배포할 수 없다.** 이 앱은 서버 함수 없이는 동작하지 않는다.
> Pages 는 정적 파일만 서빙하므로 `/api/analyze` 가 404 가 되고, 사진 인식 단계에서 멈춘다.
> Gemini 키를 프론트엔드에 넣어 우회하면 키가 즉시 공개된다. 절대 하지 말 것.

## 로컬 실행

```bash
npm test                       # 검증 (API 키 불필요)
npx wrangler dev               # 로컬 서버 (http://localhost:8787)
```

`wrangler dev` 로 Gemini 를 실제로 부르려면 프로젝트 루트에 `.dev.vars` 를 만든다
(`.gitignore` 에 걸려 있어 커밋되지 않는다):

```
GEMINI_API_KEY=여기에_키
```

## 배포 — Cloudflare Workers (권장)

정적 파일과 API 를 워커 하나가 함께 서빙한다. 무료 한도는 하루 10만 요청.

```bash
npx wrangler login

# 1) 일일 상한 카운터용 KV 네임스페이스 생성
npx wrangler kv namespace create RATE_LIMIT
#    출력된 id 를 wrangler.toml 의 [[kv_namespaces]] 블록에 넣고 주석을 푼다

# 2) API 키는 secret 으로 (vars 에 넣으면 대시보드에 노출된다)
npx wrangler secret put GEMINI_API_KEY

# 3) 배포
npx wrangler deploy
```

배포되면 `https://happy-learning-diary.<계정>.workers.dev` 가 나온다.
그 주소를 `wrangler.toml` 의 `ALLOWED_ORIGINS` 에 적고 한 번 더 `deploy` 한다.
(비워 두면 "요청이 도착한 자기 origin" 만 허용되므로 대개 그대로도 동작하지만,
커스텀 도메인을 붙였다면 명시해야 한다.)

## 배포 — Netlify (기존, 전환기용)

```
publish  = public
functions = netlify/functions
```

Netlify 대시보드 → Site settings → Environment variables 에 `GEMINI_API_KEY` 를 넣는다.
`netlify.toml` 의 리다이렉트가 `/api/analyze` → `/.netlify/functions/analyze` 를 이어 준다.

⚠️ Netlify 쪽 일일 상한은 **인스턴스 로컬 카운터**라 완전하지 않다.
함수 인스턴스가 여러 개 뜨면 각자 세기 때문이다.
제대로 된 상한이 필요하면 Cloudflare(KV) 쪽을 쓴다.

## 환경변수

| 이름 | 필수 | 기본값 | 설명 |
|---|---|---|---|
| `GEMINI_API_KEY` | ✅ | — | Gemini API 키. **secret 으로 넣을 것** |
| `ALLOWED_ORIGINS` | | 요청의 자기 origin | 쉼표로 구분한 허용 origin 목록 |
| `DAILY_CALL_LIMIT` | | `500` | 하루 전체 호출 상한 (KST 자정 초기화) |
| `DAILY_PER_IP_LIMIT` | | `60` | IP 하나당 하루 상한 |

## 왜 이런 제한이 걸려 있나

`/api/analyze` 는 **인증 없는 공개 엔드포인트**이고, 호출 하나하나가 내 Gemini 키로
과금된다. 아무 보호가 없으면 주소만 알면 누구나 내 요금으로 LLM 을 쓸 수 있다.
그래서 3중으로 막는다.

1. **Origin 검사** — 브라우저는 same-origin POST 에도 `Origin` 헤더를 붙인다.
   `curl` 같은 직접 호출은 헤더가 없어 403 으로 걸린다.
2. **일일 상한** — IP 당 / 전체. Cloudflare 에서는 KV 로 인스턴스 간 공유된다.
3. **입력 크기 상한** — 사진 4MB, 글 4000자.

여기에 더해 클라이언트가 업로드 전에 사진을 긴 변 1600px / JPEG 0.8 로 줄인다.
페이로드 상한을 피하는 동시에 함수 실행 시간(= 사용량)도 줄어든다.

## 미션 설계상 중요한 제약

`corrected` 는 반드시 **이번 미션 범위의 오류만** 고친 문장이어야 한다
(`src/prompts.js` 에서 강제한다).

전체를 다 고쳐 버리면 미션 1 을 통과하는 순간 문장이 완성돼서
미션 2(띄어쓰기)·3(조사)에 고칠 거리가 남지 않는다. 3단계 학습이 통째로 무너진다.
프롬프트를 손볼 때 이 부분을 깨뜨리지 않도록 주의할 것.
