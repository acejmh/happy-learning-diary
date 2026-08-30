/**
 * 플랫폼 무관 핵심 핸들러.
 * Vercel Functions v2 · Cloudflare Workers · Netlify Functions v2 가
 * 모두 같은 Web 표준 Request/Response 를 쓰므로 이 파일 하나를 공유한다.
 *
 * 엔드포인트는 하나(/api/analyze)이고 요청 형태로 갈라진다.
 *
 *   multipart/form-data          → 사진 OCR
 *   { mode: 'find',  text, mission }
 *       → { kind, items: [{ wrong, ctx|mark, hint }] }        정답 없음
 *   { mode: 'grade', text, mission, answers, reveal? }
 *       → { results: [{ wrong, ok, answer?, why? }] }
 *
 * 정답(answer/why)은 맞혔을 때, 또는 reveal(모르겠어요)일 때만 내려간다.
 */

import { callGemini, GeminiError } from "./gemini.js";
import { OCR_PROMPT, MISSIONS, buildFindPrompt, buildGradePrompt } from "./prompts.js";
import {
  LIMITS,
  GuardError,
  checkOrigin,
  clientIp,
  enforceRateLimit
} from "./guard.js";

/** 한 미션에서 다룰 수 있는 항목 수 상한. 프롬프트 상한(4)보다 넉넉하게 둔다. */
const MAX_ITEMS = 8;
/** 낱말/문장 하나의 길이 상한. */
const MAX_ITEM_CHARS = 400;

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
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }

  return btoa(binary);
}

const squash = (s) => String(s).replace(/\s+/g, " ").trim();

/**
 * 모델이 돌려준 조각이 원문에 실제로 있는지 확인한다.
 * 있는 그대로 옮기라고 지시해도 슬쩍 고쳐서 보내는 일이 있는데,
 * 그걸 그대로 화면에 띄우면 아이가 틀리지도 않은 것을 고치게 된다.
 */
function appearsIn(text, fragment) {
  if (!fragment) return false;
  return text.includes(fragment) || squash(text).includes(squash(fragment));
}

/* ─────────────────────────────────────────── 사진 OCR */

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

/* ─────────────────────────────────────────── 공통 검증 */

function readTextAndMission(body) {
  const text = String(body.text || "").trim();
  const mission = String(body.mission || "").trim();

  if (!text) return { error: json(400, { error: "글이 없습니다." }) };

  if (text.length > LIMITS.MAX_TEXT_CHARS) {
    return {
      error: json(413, { error: `글이 너무 길어요(최대 ${LIMITS.MAX_TEXT_CHARS}자).` })
    };
  }

  if (!MISSIONS[mission]) {
    return { error: json(400, { error: "미션 정보가 올바르지 않습니다." }) };
  }

  return { text, mission, kind: MISSIONS[mission].kind };
}

/* ─────────────────────────────────────────── 1단계: 고칠 곳 찾기 */

async function handleFind(body, apiKey) {
  const parsed = readTextAndMission(body);
  if (parsed.error) return parsed.error;

  const { text, mission, kind } = parsed;

  const raw = await callGemini(
    apiKey,
    [{ role: "user", parts: [{ text: buildFindPrompt({ text, mission }) }] }],
    { temperature: 0.15, maxOutputTokens: 2048, jsonMode: true }
  );

  let parsedJson;

  try {
    parsedJson = extractJson(raw);
  } catch {
    console.error("find: JSON 파싱 실패. raw:", raw.slice(0, 500));
    return json(502, { error: "AI 결과를 해석하지 못했어요. 다시 시도해 주세요." });
  }

  const seen = new Set();

  const items = (Array.isArray(parsedJson.items) ? parsedJson.items : [])
    .filter((it) => it && typeof it === "object")
    .map((it) => ({
      wrong: String(it.wrong ?? "").trim(),
      ctx: String(it.ctx ?? "").trim(),
      mark: String(it.mark ?? "").trim(),
      hint: String(it.hint ?? "").trim()
    }))
    // 원문에 실제로 있는 것만. 모델이 고쳐서 보낸 것은 버린다.
    .filter((it) => it.wrong && it.wrong.length <= MAX_ITEM_CHARS && appearsIn(text, it.wrong))
    // 같은 것 두 번 내보내지 않는다.
    .filter((it) => (seen.has(it.wrong) ? false : (seen.add(it.wrong), true)))
    .slice(0, MAX_ITEMS)
    .map((it) =>
      kind === "sentence"
        ? {
            wrong: it.wrong,
            // mark 도 문장 안에 실제로 있어야 밑줄을 칠 수 있다.
            mark: it.wrong.includes(it.mark) ? it.mark : "",
            hint: it.hint
          }
        : {
            wrong: it.wrong,
            ctx: appearsIn(text, it.ctx) ? it.ctx : "",
            hint: it.hint
          }
    );

  return json(200, { kind, mission, items });
}

/* ─────────────────────────────────────────── 2단계: 채점 */

async function handleGrade(body, apiKey) {
  const parsed = readTextAndMission(body);
  if (parsed.error) return parsed.error;

  const { text, mission, kind } = parsed;
  const reveal = body.reveal === true;

  const answers = (Array.isArray(body.answers) ? body.answers : [])
    .filter((a) => a && typeof a === "object")
    .slice(0, MAX_ITEMS)
    .map((a) => ({
      wrong: String(a.wrong ?? "").trim(),
      input: String(a.input ?? "").trim()
    }))
    .filter((a) => a.wrong);

  if (answers.length === 0) {
    return json(400, { error: "채점할 항목이 없습니다." });
  }

  if (answers.some((a) => a.wrong.length > MAX_ITEM_CHARS || a.input.length > MAX_ITEM_CHARS)) {
    return json(413, { error: `한 항목이 너무 길어요(최대 ${MAX_ITEM_CHARS}자).` });
  }

  const raw = await callGemini(
    apiKey,
    [{ role: "user", parts: [{ text: buildGradePrompt({ text, mission, answers }) }] }],
    { temperature: 0.1, maxOutputTokens: 2048, jsonMode: true }
  );

  let parsedJson;

  try {
    parsedJson = extractJson(raw);
  } catch {
    console.error("grade: JSON 파싱 실패. raw:", raw.slice(0, 500));
    return json(502, { error: "AI 결과를 해석하지 못했어요. 다시 시도해 주세요." });
  }

  const got = Array.isArray(parsedJson.results) ? parsedJson.results : [];

  /* 순서로 맞춘다. 모델이 개수를 틀리게 주더라도 보낸 항목 수만큼은 반드시 돌려준다.
     빠진 자리는 "못 맞힘"으로 채워야 아이 화면이 비지 않는다. */
  const results = answers.map((a, i) => {
    const r = got[i] && typeof got[i] === "object" ? got[i] : {};
    const ok = r.ok === true;

    const out = { wrong: a.wrong, input: a.input, ok };

    if (ok || reveal) {
      out.answer = String(r.answer ?? (ok ? a.input : "")).trim();
      out.why = String(r.why ?? "").trim();
    }

    return out;
  });

  return json(200, {
    kind,
    mission,
    passed: results.every((r) => r.ok),
    results
  });
}

/* ─────────────────────────────────────────── 진입점 */

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

    let body;

    try {
      body = await request.json();
    } catch {
      return json(400, { error: "요청 본문이 올바른 JSON 형식이 아닙니다." });
    }

    const mode = String(body.mode || "").trim();

    if (mode === "find") return await handleFind(body, apiKey);
    if (mode === "grade") return await handleGrade(body, apiKey);

    return json(400, { error: "mode 는 find 또는 grade 여야 합니다." });
  } catch (error) {
    if (error instanceof GuardError || error instanceof GeminiError) {
      return json(error.status, { error: error.message });
    }

    console.error("analyze error:", error);

    return json(500, { error: "처리 중 오류가 발생했습니다. 다시 시도해 주세요." });
  }
}
