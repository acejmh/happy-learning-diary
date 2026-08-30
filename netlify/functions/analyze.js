const Busboy = require("busboy");

const GEMINI_MODEL = "gemini-3.6-flash";

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(data)
  };
}

function getHeader(headers = {}, name) {
  const target = name.toLowerCase();

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      return headers[key];
    }
  }

  return "";
}

async function callGemini(contents, options = {}) {
  const apiKey = String(process.env.GEMINI_API_KEY || "").trim();

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY 환경변수가 설정되지 않았습니다."
    );
  }

  const model = GEMINI_MODEL;

  const url = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  );

  url.searchParams.set("key", apiKey);

  const generationConfig = {
    temperature: options.temperature ?? 0.1,
    maxOutputTokens: options.maxOutputTokens ?? 4096
  };

  if (options.jsonMode) {
    generationConfig.responseMimeType = "application/json";
  }

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents,
      generationConfig
    })
  });

  const responseText = await response.text();

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Gemini 응답을 해석할 수 없습니다. HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      `Gemini API 요청 실패: HTTP ${response.status}`
    );
  }

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("") || "";

  if (!text.trim()) {
    throw new Error("Gemini가 인식 결과를 반환하지 않았습니다.");
  }

  return text.trim();
}


function parseMultipartForm(event) {
  return new Promise((resolve, reject) => {
    const headers = event.headers || {};
    const contentType = getHeader(headers, "content-type");

    let busboy;

    try {
      busboy = Busboy({
        headers: {
          "content-type": contentType
        }
      });
    } catch (error) {
      reject(error);
      return;
    }

    const fields = {};
    const files = [];

    busboy.on("field", (fieldName, value) => {
      fields[fieldName] = value;
    });

    busboy.on("file", (fieldName, file, info) => {
      const chunks = [];

      file.on("data", (chunk) => {
        chunks.push(chunk);
      });

      file.on("end", () => {
        files.push({
          fieldName,
          filename: info.filename,
          mimeType: info.mimeType || "image/jpeg",
          buffer: Buffer.concat(chunks)
        });
      });
    });

    busboy.on("finish", () => {
      resolve({
        fields,
        files
      });
    });

    busboy.on("error", reject);

    try {
      if (event.isBase64Encoded) {
        busboy.end(Buffer.from(event.body || "", "base64"));
      } else {
        busboy.end(event.body || "");
      }
    } catch (error) {
      reject(error);
    }
  });
}

function extractJson(text) {
  let cleaned = String(text).trim();

  // ```json ... ``` 형태로 반환되는 경우 제거
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

function getImageFile(files) {
  if (!files || files.length === 0) {
    return null;
  }

  // image 필드 우선, 없으면 첫 번째 파일 사용
  return (
    files.find((file) => file.fieldName === "image") ||
    files.find((file) => file.mimeType.startsWith("image/")) ||
    files[0]
  );
}

exports.handler = async (event) => {
  try {
    const method = event.httpMethod || "GET";

    if (method !== "POST") {
      return jsonResponse(405, {
        error: "POST 요청만 허용됩니다."
      });
    }

    const contentType = getHeader(
      event.headers || {},
      "content-type"
    );

    /*
     * 1. 사진 업로드 및 글씨 인식
     */
    if (contentType.includes("multipart/form-data")) {
      const { files } = await parseMultipartForm(event);
      const imageFile = getImageFile(files);

      if (!imageFile) {
        return jsonResponse(400, {
          error: "업로드된 사진을 찾을 수 없습니다."
        });
      }

      if (!imageFile.mimeType.startsWith("image/")) {
        return jsonResponse(400, {
          error: "이미지 파일만 업로드할 수 있습니다."
        });
      }

      const imageBase64 = imageFile.buffer.toString("base64");

      const ocrPrompt = `
당신은 한국어 손글씨/인쇄글 OCR 엔진입니다. 아래 이미지의 글자를 "있는 그대로" 전사하세요.

절대 금지:
- 이미지에 없는 문장, 단어, 설명을 추가하지 마세요.
- "Row 1", "Line 2", "Wait", "네", "정확합니다", "Everything is clear" 같은 메타 설명을 출력하지 마세요.
- 질문에 답하지 마세요.
- 맞춤법, 띄어쓰기, 문장 표현을 교정하지 마세요.
- 글의 내용을 요약하거나 추측하지 마세요.
- 마크다운, 백틱, 따옴표, 번호, 불릿, 제목을 사용하지 마세요.

전사 방법:
1. 학생이 쓴 실제 글자만 읽으세요. 사진 속 안내문, 예시문, 인쇄된 UI 글자는 제외하세요.
2. 글의 위치를 먼저 파악한 뒤, 위에서 아래로, 같은 줄에서는 왼쪽에서 오른쪽 순서로 읽으세요.
3. 여러 조각으로 나뉜 한 문장은 하나의 자연스러운 줄로 합치세요. 단어가 세로로 배치된 것처럼 보여도 문맥상 같은 문장의 일부라면 올바른 읽기 순서로 합치세요.
4. 줄이 바뀐 경우에만 줄바꿈을 넣으세요. "Row 1:"이나 "Line 1:" 같은 표시는 절대 넣지 마세요.
5. 사진에 보이는 띄어쓰기와 철자를 그대로 유지하세요. 확실하지 않은 글자만 [판독불가]로 표시하세요.
6. 이미지에 실제로 보이는 마지막 글자까지만 출력하세요.
7. 결과는 전사한 문장만 출력하세요. 설명은 한 글자도 덧붙이지 마세요.

출력 예:
맑음
오늘 수학시간에 세자리와 두자리의 곱하는 원리를 배웠다.
그리고 곱하는 방식에 대해서 배웠다.

이 예시는 형식만 보여 주는 것이며, 이미지에 없는 예시 문장은 출력하지 마세요.
`;

      const recognizedText = await callGemini(
        [
          {
            role: "user",
            parts: [
              {
                text: ocrPrompt
              },
              {
                inlineData: {
                  mimeType: imageFile.mimeType,
                  data: imageBase64
                }
              }
            ]
          }
        ],
        {
          temperature: 0.05,
          maxOutputTokens: 4096
        }
      );

      return jsonResponse(200, {
        text: recognizedText.trim()
      });
    }

    /*
     * 2. 맞춤법·띄어쓰기·조사·문맥 점검
     */
    let body;

    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return jsonResponse(400, {
        error: "요청 본문이 올바른 JSON 형식이 아닙니다."
      });
    }

    const original = String(body.original || "").trim();
    const answer = String(body.answer || "").trim();
    const mission = String(body.mission || "").trim();

    if (!original) {
      return jsonResponse(400, {
        error: "원문이 없습니다."
      });
    }

    if (!answer) {
      return jsonResponse(400, {
        error: "학생의 답안이 없습니다."
      });
    }

    if (!mission) {
      return jsonResponse(400, {
        error: "미션 정보가 없습니다."
      });
    }

    const missionGuide = {
      "1": `
맞춤법 미션입니다.
- 단어의 올바른 표기
- 잘못 쓴 글자
- 문장 부호
- 기본적인 어문 규칙을 중심으로 확인합니다.
`,
      "2": `
띄어쓰기 미션입니다.
- 의존 명사
- 보조 용언
- 단어와 조사 사이
- 자연스러운 단어 단위의 띄어쓰기를 중심으로 확인합니다.
`,
      "3": `
조사와 문맥 미션입니다.
- 이/가, 은/는, 을/를, 에/에서, 와/과 등의 조사 누락
- 주어와 서술어의 연결
- 문장 사이의 자연스러운 흐름
- 앞뒤 내용의 연결
- 의미가 달라지거나 어색해지는 부분을 확인합니다.
`
    };

    const guide =
      missionGuide[mission] ||
      `
맞춤법, 띄어쓰기, 조사 누락, 문장 흐름을 종합적으로 확인합니다.
`;

    const checkingPrompt = `
당신은 초등학생의 글을 친절하게 교정해 주는 한국어 선생님입니다.

아래 원문과 학생의 수정 답안을 비교해 주세요.

[원문]
${original}

[학생의 수정 답안]
${answer}

[현재 미션]
${mission}

${guide}

판정 기준:
1. 학생의 답안이 원문의 뜻을 유지해야 합니다.
2. 현재 미션에서 요구하는 부분을 제대로 고쳤는지 판단합니다.
3. 이미 올바른 부분을 억지로 고치지 않습니다.
4. 의미가 바뀌는 수정은 통과시키지 않습니다.
5. 답안이 짧거나 의미 없는 내용이면 통과시키지 않습니다.
6. 맞춤법·띄어쓰기·조사·문맥상 문제가 없으면 pass는 true로 판단합니다.
7. 수정할 부분이 남아 있으면 pass는 false로 판단합니다.
8. corrected에는 전체 문장을 자연스럽게 고친 최종본을 작성합니다.
9. corrections에는 실제로 바뀐 부분만 작성합니다.
10. 학생이 잘 고친 경우에는 칭찬하는 피드백을 작성합니다.

반드시 아래 JSON 형식만 반환하세요.
마크다운이나 설명 문장은 JSON 앞뒤에 붙이지 마세요.

{
  "pass": true,
  "feedback": "짧고 친절한 한국어 피드백",
  "corrected": "전체 문장을 고친 최종본",
  "corrections": [
    {
      "before": "고치기 전 표현",
      "after": "고친 표현",
      "reason": "왜 고쳤는지 초등학생도 이해할 수 있게 설명"
    }
  ]
}
`;

    const resultText = await callGemini(
      [
        {
          role: "user",
          parts: [
            {
              text: checkingPrompt
            }
          ]
        }
      ],
      {
        temperature: 0.1,
        maxOutputTokens: 4096,
        jsonMode: true
      }
    );

    let result;

    try {
      result = extractJson(resultText);
    } catch {
      return jsonResponse(500, {
        error: "Gemini의 결과를 JSON으로 해석하지 못했습니다.",
        raw: resultText
      });
    }

    return jsonResponse(200, {
      pass: Boolean(result.pass),
      feedback: result.feedback || "",
      corrected: result.corrected || answer,
      corrections: Array.isArray(result.corrections)
        ? result.corrections
        : []
    });
  } catch (error) {
    console.error("analyze function error:", error);

    return jsonResponse(500, {
      error:
        error.message ||
        "사진 인식 또는 글 점검 중 오류가 발생했습니다."
    });
  }
};
