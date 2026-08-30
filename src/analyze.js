/**
 * 플랫폼 무관 핵심 핸들러.
 * Netlify Functions v2 와 Cloudflare Workers 가 동일한 Web 표준
 * Request/Response 를 쓰므로, 이 파일 하나를 양쪽에서 공유한다.
 */

import { callGemini, GeminiError } from "./gemini.js";
import { OCR_PROMPT, buildCheckPrompt } from "./prompts.js";
import {
  LIMITS,
  GuardError,
  checkOrigin,
  clientIp,
  enforceRateLimit
} from "./guard.js";

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

/** Gemini 가 ```json 펜스를 붙여 보내는 경우까지 흡수한다. */
export function extractJson(text) {
  let cleaned = String(text).trim();

  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace !== -1) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  return JSON.parse(cleaned);
}

/** ArrayBuffer -> base64. Workers 에는 Buffer 가 없으므로 직접 만든다. */
function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const chunk = 0x8000;
  let binary = "";

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunk)
    );
  }

  return btoa(binary);
}

async function handleOcr(request, apiKey) {
  let form;

  try {
    form = await request.formData();
  } catch {
    return json(400, { error: "사진 데이터를 읽을 수 없습니다." });
  }

  const image = form.get("image");

  if (!image || typeof image === "string") {
    return json(400, { error: "업로드된 사진을 찾을 수 없습니다." });
  }

  const mimeType = image.type || "image/jpeg";

  if (!mimeType.startsWith("image/")) {
    return json(400, { error: "이미지 파일만 업로드할 수 있습니다." });
  }

  if (image.size > LIMITS.MAX_IMAGE_BYTES) {
    const mb = (LIMITS.MAX_IMAGE_BYTES / 1024 / 1024).toFixed(1);
    return json(413, {
      error: `사진이 너무 커요(최대 ${mb}MB). 조금 더 작게 찍거나 다시 시도해 주세요.`
    });
  }

  const imageBase64 = toBase64(await image.arrayBuffer());

  const recognizedText = await callGemini(
    apiKey,
    [
      {
        role: "user",
        parts: [
          { text: OCR_PROMPT },
          { inlineData: { mimeType, data: imageBase64 } }
        ]
      }
    ],
    { temperature: 0.05, maxOutputTokens: 2048 }
  );

  return json(200, { text: recognizedText.trim() });
}

async function handleCheck(request, apiKey) {
  let body;

  try {
    body = await request.json();
  } catch {
    return json(400, { error: "요청 본문이 올바른 JSON 형식이 아닙니다." });
  }

  const original = String(body.original || "").trim();
  const answer = String(body.answer || "").trim();
  const mission = String(body.mission || "").trim();

  if (!original) return json(400, { error: "원문이 없습니다." });
  if (!answer) return json(400, { error: "학생의 답안이 없습니다." });
  if (!["1", "2", "3"].includes(mission)) {
    return json(400, { error: "미션 정보가 올바르지 않습니다." });
  }

  if (
    original.length > LIMITS.MAX_TEXT_CHARS ||
    answer.length > LIMITS.MAX_TEXT_CHARS
  ) {
    return json(413, {
      error: `글이 너무 길어요(최대 ${LIMITS.MAX_TEXT_CHARS}자).`
    });
  }

  const resultText = await callGemini(
    apiKey,
    [
      {
        role: "user",
        parts: [{ text: buildCheckPrompt({ original, answer, mission }) }]
      }
    ],
    { temperature: 0.1, maxOutputTokens: 2048, jsonMode: true }
  );

  let result;

  try {
    result = extractJson(resultText);
  } catch {
    // 원문(raw)을 클라이언트로 흘리지 않는다. 서버 로그로만 남긴다.
    console.error("JSON parse failed. raw:", resultText.slice(0, 500));
    return json(502, { error: "AI 결과를 해석하지 못했습니다. 다시 시도해 주세요." });
  }

  const corrections = Array.isArray(result.corrections)
    ? result.corrections
        .filter((c) => c && typeof c === "object")
        .slice(0, 20)
        .map((c) => ({
          before: String(c.before ?? ""),
          after: String(c.after ?? ""),
          reason: String(c.reason ?? "")
        }))
    : [];

  return json(200, {
    pass: Boolean(result.pass),
    feedback: String(result.feedback || ""),
    corrected: String(result.corrected || answer),
    corrections
  });
}

/**
 * @param {Request} request
 * @param {{env: object, context?: object, limiter?: object}} deps
 */
export async function handleAnalyze(request, { env = {}, context = {}, limiter } = {}) {
  try {
    if (request.method !== "POST") {
      return json(405, { error: "POST 요청만 허용됩니다." });
    }

    checkOrigin(request, env.ALLOWED_ORIGINS);

    await enforceRateLimit(limiter, clientIp(request, context), env);

    const apiKey = env.GEMINI_API_KEY;
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      return await handleOcr(request, apiKey);
    }

    return await handleCheck(request, apiKey);
  } catch (error) {
    if (error instanceof GuardError || error instanceof GeminiError) {
      return json(error.status, { error: error.message });
    }

    console.error("analyze error:", error);

    return json(500, { error: "처리 중 오류가 발생했습니다. 다시 시도해 주세요." });
  }
}
