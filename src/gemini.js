/**
 * Gemini API 호출 래퍼. 플랫폼(Netlify / Cloudflare)에 의존하지 않는다.
 */

export const GEMINI_MODEL = "gemini-3.7-flash";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export class GeminiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
  }
}

export async function callGemini(apiKey, contents, options = {}) {
  const key = String(apiKey || "").trim();

  if (!key) {
    throw new GeminiError("GEMINI_API_KEY 환경변수가 설정되지 않았습니다.", 500);
  }

  const model = options.model || GEMINI_MODEL;

  const generationConfig = {
    temperature: options.temperature ?? 0.1,
    maxOutputTokens: options.maxOutputTokens ?? 2048
  };

  if (options.jsonMode) {
    generationConfig.responseMimeType = "application/json";
  }

  // 키는 URL 쿼리스트링 대신 헤더로 보낸다. 쿼리스트링은 각종 로그/리퍼러에 남는다.
  let response;

  try {
    response = await fetch(`${ENDPOINT}/${model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({ contents, generationConfig }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 45000)
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new GeminiError("Gemini 응답이 너무 오래 걸립니다. 사진을 줄여서 다시 시도해 주세요.", 504);
    }
    throw new GeminiError(`Gemini에 연결하지 못했습니다: ${error.message}`);
  }

  const responseText = await response.text();

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new GeminiError(`Gemini 응답을 해석할 수 없습니다. HTTP ${response.status}`);
  }

  if (!response.ok) {
    // 상류의 원본 메시지에는 키 관련 힌트가 섞일 수 있어 그대로 노출하지 않는다.
    const upstream = data?.error?.message || `HTTP ${response.status}`;
    console.error("Gemini API error:", upstream);

    if (response.status === 429) {
      throw new GeminiError("지금은 요청이 많아요. 잠시 후 다시 시도해 주세요.", 429);
    }

    throw new GeminiError("AI 서버가 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }

  const candidate = data?.candidates?.[0];

  if (candidate?.finishReason === "SAFETY") {
    throw new GeminiError("이 사진은 처리할 수 없어요. 다른 사진으로 시도해 주세요.", 422);
  }

  const text =
    candidate?.content?.parts?.map((part) => part.text || "").join("") || "";

  if (!text.trim()) {
    throw new GeminiError("AI가 결과를 반환하지 않았습니다. 다시 시도해 주세요.", 502);
  }

  return text.trim();
}
