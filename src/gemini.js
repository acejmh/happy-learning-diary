/**
 * Gemini API 호출 래퍼. 플랫폼(Vercel / Cloudflare / Netlify)에 의존하지 않는다.
 */

/*
 * 기본 모델을 3.7 이 아니라 3.6 으로 둔다.
 * 최신 모델은 수요가 몰려 503 "This model is currently experiencing high demand"
 * 가 자주 난다. 실제로 2026-08-30 배포 검증 중 3.7 이 지속적으로 거부했다.
 * 한 세대 아래가 품질 차이는 거의 없으면서 훨씬 안정적이다.
 */
export const GEMINI_MODEL = "gemini-3.6-flash";

/** 기본 모델이 과부하일 때 순서대로 내려간다. */
export const GEMINI_FALLBACK_MODELS = ["gemini-3.5-flash", "gemini-2.5-flash"];

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/** 잠깐 뒤 다시 하면 될 가능성이 있는 상태 코드 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** 모델 하나당 재시도 간격. 길이 + 1 이 모델당 총 시도 횟수. */
const RETRY_DELAYS_MS = [600, 1800];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class GeminiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
  }
}

/** 한 번의 호출. 성공하면 텍스트를, 실패하면 status 를 단 에러를 던진다. */
async function callOnce(apiKey, model, contents, generationConfig, timeoutMs) {
  let response;

  try {
    response = await fetch(`${ENDPOINT}/${model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // 키는 쿼리스트링이 아니라 헤더로. 쿼리스트링은 각종 로그·리퍼러에 남는다.
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({ contents, generationConfig }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      const e = new GeminiError("Gemini 응답 시간 초과", 504);
      e.retryable = true;
      throw e;
    }
    const e = new GeminiError(`Gemini 연결 실패: ${error.message}`, 502);
    e.retryable = true;
    throw e;
  }

  const responseText = await response.text();

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    const e = new GeminiError(`Gemini 응답 파싱 실패 (HTTP ${response.status})`, 502);
    e.retryable = RETRYABLE_STATUS.has(response.status);
    e.upstreamStatus = response.status;
    throw e;
  }

  if (!response.ok) {
    // 상류 원문은 로그로만. 키 관련 힌트가 섞일 수 있어 클라이언트로 보내지 않는다.
    const upstream = data?.error?.message || `HTTP ${response.status}`;
    console.error(`Gemini API error [${model}]:`, upstream);

    const e = new GeminiError(upstream, response.status);
    e.retryable = RETRYABLE_STATUS.has(response.status);
    e.upstreamStatus = response.status;
    throw e;
  }

  const candidate = data?.candidates?.[0];

  if (candidate?.finishReason === "SAFETY") {
    // 재시도해도 같은 결과다.
    throw new GeminiError("이 사진은 처리할 수 없어요. 다른 사진으로 시도해 주세요.", 422);
  }

  const text =
    candidate?.content?.parts?.map((part) => part.text || "").join("") || "";

  if (!text.trim()) {
    const e = new GeminiError("Gemini 가 빈 응답을 반환", 502);
    e.retryable = true;
    throw e;
  }

  return text.trim();
}

/**
 * 모델 폴백 + 재시도를 감싼 호출.
 * 재시도 불가능한 오류(400, 403, 422 등)는 즉시 포기한다.
 */
export async function callGemini(apiKey, contents, options = {}) {
  const key = String(apiKey || "").trim();

  if (!key) {
    throw new GeminiError("GEMINI_API_KEY 환경변수가 설정되지 않았습니다.", 500);
  }

  const generationConfig = {
    temperature: options.temperature ?? 0.1,
    maxOutputTokens: options.maxOutputTokens ?? 2048
  };

  if (options.jsonMode) {
    generationConfig.responseMimeType = "application/json";
  }

  const timeoutMs = options.timeoutMs ?? 30000;

  const models = options.model
    ? [options.model]
    : [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS];

  let lastError;

  for (const model of models) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await callOnce(key, model, contents, generationConfig, timeoutMs);
      } catch (error) {
        lastError = error;

        // 404 는 "그런 모델이 없다"는 뜻이다.
        // 같은 모델로 다시 시도해봐야 소용없으니 곧바로 다음 모델로 넘어간다.
        if (error.upstreamStatus === 404) {
          break;
        }

        if (!error.retryable) {
          throw toClientError(error);
        }

        if (attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]);
        }
      }
    }
  }

  throw toClientError(lastError);
}

/**
 * 클라이언트에 보낼 형태로 바꾼다.
 * 상류 메시지는 감추되 **상태 코드는 남긴다** — 이게 없으면 장애 때 원인을 못 본다.
 */
function toClientError(error) {
  const status = error?.upstreamStatus;

  if (status === 429) {
    return new GeminiError("지금은 요청이 많아요. 잠시 후 다시 시도해 주세요. (429)", 429);
  }

  if (status === 503 || status === 500 || status === 502 || status === 504) {
    return new GeminiError(
      `AI 서버가 지금 많이 바빠요. 잠시 후 다시 해볼까요? (${status})`,
      503
    );
  }

  if (error instanceof GeminiError && (error.status === 422 || error.status === 500)) {
    return error;
  }

  return new GeminiError(
    `AI 서버가 요청을 처리하지 못했어요${status ? ` (${status})` : ""}. 잠시 후 다시 시도해 주세요.`,
    502
  );
}
