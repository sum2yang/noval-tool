import http from "node:http";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import process from "node:process";

const nextPort = Number(process.env.NEXT_SMOKE_PORT || 3113);
const providerPort = Number(process.env.MOCK_PROVIDER_PORT || 3123);
const loopbackAlias = process.env.SMOKE_LOOPBACK_HOST || "localhost.localstack.cloud";

const baseUrl = `http://localhost:${nextPort}`;
const providerBaseUrl = `http://${loopbackAlias}:${providerPort}/v1`;
const nextBin = "node_modules/next/dist/bin/next";

const promptOverlayMarker = "强调交易收益链和港岛势力秩序";
const skillOverlayMarker = "Reviewer 偏重";
const onboardingTitle = "港综资本局";
const aiOnboardingTitle = "AI港综夜局";
const blankProjectTitle = "港口旧账局";
const blankAuthorNotes = "已有材料以码头账本和旧商会恩怨为主线，请先整理再补问。";
const blankMarkdownMarker = "旧账簿显示，第七码头的夜班仓位会优先让给能当场结清税票的人。";
const blankHtmlMarker = "首帖摘要：旧商会会借秋汛船期压低新人的夜班装卸顺位。";
const blankHtmlOneboxMarker = "Onebox 摘要：夜航货船必须先核验税票，再按潮位钟点入港。";
const blankScriptNoiseMarker = "不要进入初始化整理正文";
const blankConflictAnswer = "主角要借夜班仓位调度撬开旧账局，但旧商会和巡捕房都盯着他的账本缺口。";
const blankWorldRulesAnswer = "越过税票和夜航底线就会被港务、巡捕和黑平码头一起清场，不能硬闯。";
const blankFactionsAnswer = "旧商会、码头帮、巡捕内线和船运金主四方互相制衡，谁都想先吃掉主角手里的旧账。";
const blankStyleAnswer = "章节先打收益点，再补规则解释；港口税票与夜航制度只做轻量考据。";
const onboardingDynamicMarker = "ONBOARDING_DYNAMIC_JSON";
const aiOnboardingAnswerByKey = {
  project_basics: "暂定名《AI港综夜局》，题材是港综商战，平台走番茄，目标长篇。",
  core_conflict: "主角必须先赢下一场能证明自己价值的小局，否则资金、人脉和盟友都会被旧势力抽走。",
  world_rules: "港岛这套局里最不能碰的是制度红线和现金流底线，一旦越线就会被监管和地下势力一起清场。",
  factions: "旧财团、社团白手套、警方内线和师门旧部四方都想吃掉主角手里的筹码，合作和背刺并存。",
  style_rules: "章节要短钩子强，重点写交易收益链和势力秩序，禁写低效误会与无收益抒情。",
  research_needs: "金融法规、港岛地理和警务体系需要查证，但只能作为事实辅助，不直接改剧情设定。",
};
const aiOnboardingQuestionTemplates = {
  project_basics: {
    title: "先把项目基本盘锁准",
    prompt: "先把这本书的暂定名、题材、平台和篇幅预期锁准，方便后面继续追问。",
    placeholder: "例如：暂定名《AI港综夜局》，题材是港综商战，平台走番茄，目标做长篇。",
    recommendedOptions: [
      {
        label: "番茄长篇",
        value: "暂定名《AI港综夜局》，题材是港综商战，平台走番茄，目标做长篇连载。",
      },
    ],
  },
  core_conflict: {
    title: "主角先要赢哪一局",
    prompt: "基于这个题材，主角眼下必须先赢下哪一场局，才能真正开始上位？",
    placeholder: "例如：先赢下一场能证明自己价值的小局。",
    recommendedOptions: [
      {
        label: "先赢第一局",
        value: aiOnboardingAnswerByKey.core_conflict,
      },
    ],
  },
  world_rules: {
    title: "这套规则最怕什么越线",
    prompt: "这个世界里最不能碰的底线和失败代价分别是什么？",
    placeholder: "例如：越线后会遭遇制度和地下势力双重清场。",
    recommendedOptions: [
      {
        label: "越线有代价",
        value: aiOnboardingAnswerByKey.world_rules,
      },
    ],
  },
  factions: {
    title: "谁会先卡主角的脖子",
    prompt: "请先锁定关键势力与关系锚点，谁会先卡主角，谁又可能临时结盟？",
    placeholder: "例如：旧财团、社团、警方内线和师门旧部如何彼此制衡。",
    recommendedOptions: [
      {
        label: "四方制衡",
        value: aiOnboardingAnswerByKey.factions,
      },
    ],
  },
  style_rules: {
    title: "文风和节奏怎么定",
    prompt: "这本书的节奏、钩子密度、叙述口吻和禁写项先怎么定？",
    placeholder: "例如：章节要短钩子强，禁写低效误会。",
    recommendedOptions: [
      {
        label: "快节奏强钩子",
        value: aiOnboardingAnswerByKey.style_rules,
      },
    ],
  },
  research_needs: {
    title: "哪些外部事实必须查",
    prompt: "最后补一下考据边界：哪些外部事实必须查，哪些内容只按项目内设写？",
    placeholder: "例如：法规、地理、制度流程需要查，剧情事实以内设为准。",
    recommendedOptions: [
      {
        label: "只查现实外壳",
        value: aiOnboardingAnswerByKey.research_needs,
      },
    ],
  },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSetCookie(header) {
  if (!header) {
    return [];
  }

  if (Array.isArray(header)) {
    return header.map((item) => item.split(";")[0]);
  }

  return String(header)
    .split(/,(?=[^;]+=[^;]+)/)
    .map((item) => item.split(";")[0].trim())
    .filter(Boolean);
}

async function fetchJson(url, options = {}, cookies = []) {
  const headers = {
    origin: baseUrl,
    ...(options.headers || {}),
  };

  if (cookies.length > 0) {
    headers.cookie = cookies.join("; ");
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  const setCookie = response.headers.get("set-cookie");
  const contentType = response.headers.get("content-type") || "";
  const nextCookies = parseSetCookie(setCookie);
  const text = await response.text();
  let data;
  let streamEvents = [];
  let streamError = null;

  if (contentType.includes("application/x-ndjson")) {
    streamEvents = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    const errorEvent = streamEvents.find((event) => event?.type === "error");
    const completedEvent = [...streamEvents].reverse().find((event) => event?.type === "completed");
    streamError = errorEvent?.error ?? null;
    data = completedEvent?.payload ?? (streamError ? { error: streamError } : null);

    return {
      status: response.status,
      data,
      cookies: nextCookies,
      streamEvents,
      streamError,
    };
  }

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return {
    status: response.status,
    data,
    cookies: nextCookies,
    streamEvents,
    streamError,
  };
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function assertOk(response, label) {
  if (response.status >= 400) {
    throw new Error(`${label} failed: ${JSON.stringify(response.data)}`);
  }

  if (response.streamError) {
    throw new Error(`${label} failed: ${JSON.stringify(response.streamError)}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function extractBodyText(body) {
  return JSON.stringify(body ?? {});
}

function findFirstMarkerIndex(haystack, markers) {
  return markers.reduce((lowest, marker) => {
    const index = haystack.indexOf(marker);
    if (index === -1) {
      return lowest;
    }

    return Math.min(lowest, index);
  }, Number.POSITIVE_INFINITY);
}

function detectTaskKind(body) {
  const bodyText = extractBodyText(body);
  const matches = [
    {
      taskKind: "onboarding_dynamic",
      index: findFirstMarkerIndex(bodyText, [onboardingDynamicMarker]),
    },
    {
      taskKind: "ingest_sources",
      index: findFirstMarkerIndex(bodyText, [
        "ingest_sources",
        "初始化整理摘要",
        "待补充问题",
        "findings.md 建议回填",
      ]),
    },
    {
      taskKind: "workflow_check",
      index: findFirstMarkerIndex(bodyText, [
        "workflow_check",
        "工作流检查结果",
        "请检查 onboarding 后的项目骨架是否足够继续推进设定和卷纲",
        "请检查 blank onboarding 后的项目骨架是否足够继续推进设定和卷纲",
      ]),
    },
  ]
    .filter((item) => Number.isFinite(item.index))
    .sort((left, right) => left.index - right.index);

  return matches[0]?.taskKind ?? "workflow_check";
}

function buildAiOnboardingQuestionOutput(bodyText) {
  const remainingKeys = Array.from(bodyText.matchAll(/^- ([a-z_]+) \|/gm), (match) => match[1]);
  const questionKey = remainingKeys[0] || "core_conflict";
  const template = aiOnboardingQuestionTemplates[questionKey] || aiOnboardingQuestionTemplates.core_conflict;

  return JSON.stringify({
    questionKey,
    title: template.title,
    prompt: template.prompt,
    placeholder: template.placeholder,
    recommendedOptions: template.recommendedOptions,
  });
}

function buildTaskOutput(taskKind, body) {
  const bodyText = extractBodyText(body);

  if (bodyText.includes("Reply with exactly OK")) {
    return "OK";
  }

  if (taskKind === "onboarding_dynamic") {
    return buildAiOnboardingQuestionOutput(bodyText);
  }

  if (taskKind === "ingest_sources") {
    return [
      "# 初始化整理摘要",
      "",
      "## 已识别信息",
      "### 故事前提与题材定位",
      `- ${blankMarkdownMarker}`,
      `- ${blankHtmlMarker}`,
      "### 角色/势力/世界规则",
      `- ${blankHtmlOneboxMarker}`,
      "- 当前材料已经写明旧账、夜班仓位与秋汛船期会直接影响主角能否站稳第一步。",
      "",
      "## 待补充问题",
      "- [核心冲突] 当前材料已经给出旧账和夜班仓位线，但还缺“主角眼下具体要赢什么、谁会先卡死他”。",
      "- [世界规则] 当前材料已经写到税票、潮位与入港顺序，但还缺“哪些规则碰了就会被联手清场”。",
      "- [势力关系] 当前材料已经出现旧商会和码头线，但还缺“谁和主角合作、谁盯着主角手里的旧账”。",
      "- [文风与考据] 当前材料已有港口制度细节，但还缺“平台向节奏要求，以及考据只做到什么边界”。",
      "",
      "## findings.md 建议回填",
      `- ${blankMarkdownMarker}`,
      `- ${blankHtmlMarker}`,
      `- ${blankHtmlOneboxMarker}`,
    ].join("\n");
  }

  return [
    "# 工作流检查结果",
    "",
    "## 当前已有项",
    "- onboarding 生成的标准 artifact 与项目级 overlay 已可读。",
    "",
    "## 风险项",
    "- 建议先执行 generate_setting / generate_outline，再进入正文阶段。",
    "",
    "## 下一步建议",
    "- 按主链继续推进。",
  ].join("\n");
}

function buildResponseApiPayload(body, requestIndex) {
  const model = typeof body?.model === "string" ? body.model : "gpt-4o-mini";
  const output = buildTaskOutput(detectTaskKind(body), body);

  return {
    id: `resp_${requestIndex}`,
    created_at: Math.floor(Date.now() / 1000),
    model,
    output: [
      {
        type: "message",
        id: `msg_${requestIndex}`,
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: output,
            annotations: [],
          },
        ],
      },
    ],
    usage: {
      input_tokens: 48,
      output_tokens: 36,
      total_tokens: 84,
    },
  };
}

function splitStreamOutput(output) {
  if (output.length <= 24) {
    return [output];
  }

  const midpoint = Math.max(1, Math.floor(output.length / 2));
  return [output.slice(0, midpoint), output.slice(midpoint)];
}

function writeSseEvent(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeResponseApiStream(response, body, requestIndex) {
  const model = typeof body?.model === "string" ? body.model : "gpt-4o-mini";
  const output = buildTaskOutput(detectTaskKind(body), body);
  const responseId = `resp_${requestIndex}`;
  const itemId = `msg_${requestIndex}`;
  const createdAt = Math.floor(Date.now() / 1000);

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  writeSseEvent(response, {
    type: "response.created",
    response: {
      id: responseId,
      created_at: createdAt,
      model,
      service_tier: null,
    },
  });

  for (const chunk of splitStreamOutput(output)) {
    writeSseEvent(response, {
      type: "response.output_text.delta",
      item_id: itemId,
      delta: chunk,
      logprobs: null,
    });
  }

  writeSseEvent(response, {
    type: "response.completed",
    response: {
      incomplete_details: null,
      usage: {
        input_tokens: 48,
        input_tokens_details: {
          cached_tokens: 0,
        },
        output_tokens: 36,
        output_tokens_details: {
          reasoning_tokens: 0,
        },
      },
      service_tier: null,
    },
  });
  response.write("data: [DONE]\n\n");
  response.end();
}

function buildChatCompletionPayload(body, requestIndex) {
  const model = typeof body?.model === "string" ? body.model : "gpt-4o-mini";
  const output = buildTaskOutput(detectTaskKind(body), body);

  return {
    id: `chatcmpl_${requestIndex}`,
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: output,
          annotations: [],
        },
      },
    ],
    usage: {
      prompt_tokens: 48,
      completion_tokens: 36,
      total_tokens: 84,
    },
  };
}

function createMockProviderServer(state) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    if (request.method !== "POST") {
      response.writeHead(405, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Method not allowed." }));
      return;
    }

    const body = await readJsonBody(request);
    state.requestBodies.push(body);
    const requestIndex = state.requestBodies.length;

    if (url.pathname === "/v1/responses") {
      if (body?.stream) {
        writeResponseApiStream(response, body, requestIndex);
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(buildResponseApiPayload(body, requestIndex)));
      return;
    }

    if (url.pathname === "/v1/chat/completions") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(buildChatCompletionPayload(body, requestIndex)));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not found." }));
  });
}

async function waitForServer() {
  for (let index = 0; index < 40; index += 1) {
    try {
      const response = await fetch(`${baseUrl}/login`);
      if (response.ok) {
        return;
      }
    } catch {}

    await sleep(1000);
  }

  throw new Error(`Server at ${baseUrl} did not become ready.`);
}

async function ensureProductionBuild() {
  try {
    await access(".next/BUILD_ID");
  } catch {
    await new Promise((resolve, reject) => {
      const build = spawn(process.execPath, [nextBin, "build"], {
        cwd: process.cwd(),
        env: process.env,
        stdio: "inherit",
      });

      build.on("exit", (code) => {
        if (code === 0) {
          resolve(undefined);
          return;
        }

        reject(new Error(`next build exited with code ${code}`));
      });

      build.on("error", reject);
    });
  }
}

async function listen(server, port, host = "0.0.0.0") {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(undefined);
    });
  });
}

async function closeServer(server) {
  if (!server?.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(undefined);
    });
  });
}

function findArtifactBy(items, predicate, label) {
  const match = items.find(predicate);
  assert(match, `${label} was not found.`);
  return match;
}

function findItemById(items, id, label) {
  const match = items.find((item) => item.id === id);
  assert(match, `${label} was not found.`);
  return match;
}

async function main() {
  await ensureProductionBuild();

  const providerState = {
    requestBodies: [],
  };

  const providerServer = createMockProviderServer(providerState);
  await listen(providerServer, providerPort);

  const child = spawn(process.execPath, [nextBin, "start", "-p", String(nextPort)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      APP_BASE_URL: baseUrl,
      BETTER_AUTH_URL: baseUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer();

    const email = `smoke-onboarding-${Date.now()}@example.com`;
    const signup = await fetchJson(`${baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Smoke Onboarding Tester",
        email,
        password: "Passw0rd123!",
      }),
    });
    assertOk(signup, "signup");
    assert(signup.cookies.length > 0, "signup succeeded but no session cookie was returned.");

    const cookies = signup.cookies;
    const endpoint = await fetchJson(
      `${baseUrl}/api/provider-endpoints`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerType: "openai",
          label: "Mock OpenAI Onboarding Smoke",
          baseURL: providerBaseUrl,
          authMode: "none",
          extraHeaders: {},
          defaultModel: "gpt-4o-mini",
        }),
      },
      cookies,
    );
    assertOk(endpoint, "endpoint creation");

    const sessionCreate = await fetchJson(
      `${baseUrl}/api/projects/bootstrap/session`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      cookies,
    );
    assertOk(sessionCreate, "create onboarding session");
    const sessionId = sessionCreate.data.session.id;

    const answers = [
      "暂定名《港综资本局》。题材是港综商战，平台走番茄，目标做长篇。",
      "主角要在港岛金融圈站稳脚跟，但黑白两道都盯着他的底牌和现金流。",
      "异能必须付出寿命代价，不能公开展示；触碰底线会被官方与地下势力同时追杀。",
      "财阀、社团、警方内线和师门是四条核心关系线，彼此互相利用也互相制衡。",
      `章节要短钩子强，${promptOverlayMarker}，禁写降智误会和无收益抒情。`,
      "金融法规、港岛地理和警务体系需要考据。",
    ];

    for (const answer of answers) {
      const response = await fetchJson(
        `${baseUrl}/api/projects/bootstrap/session/${sessionId}/answer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "answer",
            answer,
          }),
        },
        cookies,
      );
      assertOk(response, "answer onboarding question");
    }

    const finalize = await fetchJson(
      `${baseUrl}/api/projects/bootstrap/session/${sessionId}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: onboardingTitle,
          genre: "港综商战",
          platform: "番茄",
        }),
      },
      cookies,
    );
    assertOk(finalize, "finalize onboarding project");

    const projectId = finalize.data.project.id;
    const artifacts = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(artifacts, "list project artifacts");

    const storyBackgroundArtifact = findArtifactBy(
      artifacts.data.items,
      (item) => item.artifactKey === "story_background",
      "story background artifact",
    );
    const promptPackArtifact = findArtifactBy(
      artifacts.data.items,
      (item) => item.artifactKey === "project_prompt_pack",
      "project prompt pack artifact",
    );
    const skillPackArtifact = findArtifactBy(
      artifacts.data.items,
      (item) => item.artifactKey === "project_skill_pack",
      "project skill pack artifact",
    );
    const onboardingBriefArtifact = findArtifactBy(
      artifacts.data.items,
      (item) => item.artifactKey === "onboarding_brief",
      "onboarding brief artifact",
    );

    assert(
      storyBackgroundArtifact.currentRevision?.content?.includes(onboardingTitle),
      "story_background did not absorb onboarding data.",
    );
    assert(
      promptPackArtifact.currentRevision?.content?.includes(promptOverlayMarker),
      "project_prompt_pack content was not generated from onboarding answers.",
    );
    assert(
      skillPackArtifact.currentRevision?.content?.includes(skillOverlayMarker),
      "project_skill_pack content was not generated from onboarding answers.",
    );
    assert(
      onboardingBriefArtifact.currentRevision?.content?.includes("问答摘要"),
      "onboarding_brief content was missing the summary section.",
    );

    const aiSessionCreate = await fetchJson(
      `${baseUrl}/api/projects/bootstrap/session`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: aiOnboardingTitle,
          genre: "港综商战",
          platform: "番茄",
          keywords: "资本局、势力经营、上位",
          endpointId: endpoint.data.id,
          modelId: "gpt-4o-mini",
        }),
      },
      cookies,
    );
    assertOk(aiSessionCreate, "create AI onboarding session");
    assert(aiSessionCreate.data.session.mode === "ai_dynamic", "AI onboarding session did not enter ai_dynamic mode.");
    assert(
      aiSessionCreate.data.session.currentQuestion?.source === "ai",
      "AI onboarding session did not expose an AI current question.",
    );
    assert(
      !aiSessionCreate.streamEvents.length ||
        aiSessionCreate.streamEvents.some((event) => event.type === "text-delta"),
      "AI onboarding session stream did not return any text delta.",
    );

    let aiSession = aiSessionCreate.data.session;

    while (aiSession.status !== "ready") {
      const questionKey = aiSession.currentQuestion?.key;
      assert(questionKey, "AI onboarding session lost its current question.");

      const answer = aiOnboardingAnswerByKey[questionKey];
      assert(answer, `Missing smoke answer for AI onboarding question ${questionKey}.`);

      const aiAnswerResponse = await fetchJson(
        `${baseUrl}/api/projects/bootstrap/session/${aiSession.id}/answer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "answer",
            answer,
          }),
        },
        cookies,
      );
      assertOk(aiAnswerResponse, `answer AI onboarding question ${questionKey}`);
      assert(
        !aiAnswerResponse.streamEvents.length || aiAnswerResponse.streamEvents.some((event) => event.type === "text-delta"),
        `AI onboarding answer stream for ${questionKey} did not return any text delta.`,
      );
      aiSession = aiAnswerResponse.data.session;
    }

    const aiFinalize = await fetchJson(
      `${baseUrl}/api/projects/bootstrap/session/${aiSession.id}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: aiOnboardingTitle,
          genre: "港综商战",
          platform: "番茄",
        }),
      },
      cookies,
    );
    assertOk(aiFinalize, "finalize AI onboarding project");
    const aiProjectId = aiFinalize.data.project.id;
    const aiArtifacts = await fetchJson(
      `${baseUrl}/api/projects/${aiProjectId}/artifacts`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(aiArtifacts, "list AI onboarding artifacts");

    const aiOnboardingBriefArtifact = findArtifactBy(
      aiArtifacts.data.items,
      (item) => item.artifactKey === "onboarding_brief",
      "AI onboarding brief artifact",
    );
    assert(
      aiOnboardingBriefArtifact.currentRevision?.content?.includes(aiOnboardingAnswerByKey.core_conflict),
      "AI onboarding brief did not keep the dynamic answers.",
    );

    const generate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskType: "workflow_check",
          userInstruction: "请检查 onboarding 后的项目骨架是否足够继续推进设定和卷纲。",
          endpointId: endpoint.data.id,
          modelId: "gpt-4o-mini",
          selectedArtifactIds: [],
          selectedReferenceIds: [],
          selectedMcpServerIds: [],
          generationOptions: {
            temperature: 0,
            maxTokens: 1200,
          },
        }),
      },
      cookies,
    );
    assertOk(generate, "workflow_check generate");
    assert(
      Array.isArray(generate.data.resolvedSkills) && generate.data.resolvedSkills.includes("project_skill_pack"),
      "resolvedSkills did not include project_skill_pack overlay.",
    );
    assert(
      Array.isArray(generate.data.resolvedArtifacts) &&
        generate.data.resolvedArtifacts.some((item) => item.artifactKey === "project_prompt_pack") &&
        generate.data.resolvedArtifacts.some((item) => item.artifactKey === "project_skill_pack"),
      "resolvedArtifacts did not include project overlay artifacts.",
    );

    const providerRequestText = providerState.requestBodies.map((body) => extractBodyText(body)).join("\n");
    assert(
      providerRequestText.includes("项目专属 Prompt Overlay") && providerRequestText.includes(promptOverlayMarker),
      "provider request did not include the project_prompt_pack overlay.",
    );
    assert(
      providerRequestText.includes("项目专属 Skill Overlay") && providerRequestText.includes(skillOverlayMarker),
      "provider request did not include the project_skill_pack overlay.",
    );
    assert(
      providerRequestText.includes(onboardingDynamicMarker),
      "provider request did not include the AI onboarding planning prompt.",
    );

    const blankProjectCreate = await fetchJson(
      `${baseUrl}/api/projects`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: blankProjectTitle,
          genre: "港口商战",
          platform: "番茄",
        }),
      },
      cookies,
    );
    assertOk(blankProjectCreate, "create blank onboarding project");
    const blankProjectId = blankProjectCreate.data.project.id;

    const markdownForm = new FormData();
    markdownForm.set(
      "file",
      new File(
        [
          [
            "# 旧账簿摘录",
            "",
            blankMarkdownMarker,
            "账房规定：遇到秋汛船期，先看税票，再看谁能当场补齐旧账。",
          ].join("\n"),
        ],
        "old-ledger.md",
        { type: "text/markdown" },
      ),
    );
    markdownForm.set("tags", "账本, 夜班");

    const markdownReference = await fetchJson(
      `${baseUrl}/api/projects/${blankProjectId}/references`,
      {
        method: "POST",
        body: markdownForm,
      },
      cookies,
    );
    assertOk(markdownReference, "blank onboarding markdown reference upload");
    const markdownReferenceItem = markdownReference.data.items?.[0];
    assert(markdownReferenceItem, "blank onboarding markdown reference upload did not return an item.");
    assert(
      markdownReferenceItem.normalizedText?.includes(blankMarkdownMarker),
      "blank markdown reference did not keep the readable text.",
    );

    const htmlForm = new FormData();
    htmlForm.set(
      "file",
      new File(
        [
          [
            "<!doctype html>",
            `<html><head><title>旧商会讨论串</title><script>window.__noise='${blankScriptNoiseMarker}'</script></head>`,
            "<body><header>论坛导航</header><article>",
            "<h1>旧商会讨论串</h1>",
            `<p>${blankHtmlMarker}</p>`,
            '<div class="onebox"><a href="https://example.com/night-port">Onebox 标题：夜港调度旧闻</a>',
            `<p>${blankHtmlOneboxMarker}</p></div>`,
            "</article><footer>论坛页脚</footer></body></html>",
          ].join(""),
        ],
        "guild-thread.html",
        { type: "text/html" },
      ),
    );
    htmlForm.set("tags", "论坛, HTML");
    htmlForm.set("sourceUrl", "https://example.com/guild-thread");

    const htmlReference = await fetchJson(
      `${baseUrl}/api/projects/${blankProjectId}/references`,
      {
        method: "POST",
        body: htmlForm,
      },
      cookies,
    );
    assertOk(htmlReference, "blank onboarding html reference upload");
    const htmlReferenceItem = htmlReference.data.items?.[0];
    assert(htmlReferenceItem, "blank onboarding html reference upload did not return an item.");
    assert(
      typeof htmlReferenceItem.normalizedText === "string" &&
        htmlReferenceItem.normalizedText.includes(blankHtmlMarker) &&
        htmlReferenceItem.normalizedText.includes(blankHtmlOneboxMarker),
      "blank html reference did not keep the visible readable text.",
    );
    assert(
      !htmlReferenceItem.normalizedText.includes(blankScriptNoiseMarker),
      "blank html reference still contained stripped script noise.",
    );

    const providerRequestStartBeforeBlankDigest = providerState.requestBodies.length;
    const blankDigestGenerate = await fetchJson(
      `${baseUrl}/api/projects/${blankProjectId}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskType: "ingest_sources",
          userInstruction: "请先把作者材料整理成初始化摘要，再标出标准 artifact 还缺的关键信息。",
          endpointId: endpoint.data.id,
          modelId: "gpt-4o-mini",
          selectedArtifactIds: [],
          selectedReferenceIds: [markdownReferenceItem.id, htmlReferenceItem.id],
          selectedMcpServerIds: [],
          generationOptions: {
            temperature: 0,
            maxTokens: 1200,
          },
        }),
      },
      cookies,
    );
    assertOk(blankDigestGenerate, "blank onboarding ingest_sources generate");
    assert(
      typeof blankDigestGenerate.data.output === "string" &&
        blankDigestGenerate.data.output.includes("## 已识别信息") &&
        blankDigestGenerate.data.output.includes("## 待补充问题") &&
        blankDigestGenerate.data.output.includes("## findings.md 建议回填"),
      "blank onboarding digest output did not match the expected contract.",
    );
    assert(
      Array.isArray(blankDigestGenerate.data.suggestedPatches) &&
        blankDigestGenerate.data.suggestedPatches.includes("findings.md"),
      "blank onboarding digest did not suggest findings.md as the accept target.",
    );
    assert(
      Array.isArray(blankDigestGenerate.data.resolvedArtifacts) && blankDigestGenerate.data.resolvedArtifacts.length === 0,
      "blank onboarding digest should not auto-resolve project artifacts when only references are selected.",
    );

    const blankDigestRequestText = providerState.requestBodies
      .slice(providerRequestStartBeforeBlankDigest)
      .map((body) => extractBodyText(body))
      .join("\n");
    assert(
      blankDigestRequestText.includes(blankMarkdownMarker),
      "blank onboarding provider request did not include the uploaded markdown material.",
    );
    assert(
      blankDigestRequestText.includes(blankHtmlMarker) && blankDigestRequestText.includes(blankHtmlOneboxMarker),
      "blank onboarding provider request did not include the extracted html readable text.",
    );
    assert(
      !blankDigestRequestText.includes(blankScriptNoiseMarker),
      "blank onboarding provider request still contained stripped html shell/script noise.",
    );

    const blankRuns = await fetchJson(
      `${baseUrl}/api/projects/${blankProjectId}/runs`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(blankRuns, "list blank onboarding runs");
    const blankRun = findItemById(blankRuns.data.items, blankDigestGenerate.data.runId, "blank onboarding digest run");
    assert(blankRun.status === "succeeded", `blank onboarding digest run status was ${blankRun.status}`);
    assert(
      Array.isArray(blankRun.selectedReferenceIds) &&
        blankRun.selectedReferenceIds.includes(markdownReferenceItem.id) &&
        blankRun.selectedReferenceIds.includes(htmlReferenceItem.id),
      "blank onboarding digest run did not persist the selected reference ids.",
    );
    assert(
      Array.isArray(blankRun.selectedArtifactIds) && blankRun.selectedArtifactIds.length === 0,
      "blank onboarding digest run should keep selectedArtifactIds empty.",
    );
    assert(
      Array.isArray(blankRun.resolvedContextArtifacts) && blankRun.resolvedContextArtifacts.length === 0,
      "blank onboarding digest run should keep resolvedContextArtifacts empty.",
    );

    const blankDrafts = await fetchJson(
      `${baseUrl}/api/projects/${blankProjectId}/drafts`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(blankDrafts, "list blank onboarding drafts");
    const blankDigestDraft = findItemById(
      blankDrafts.data.items,
      blankDigestGenerate.data.draftId,
      "blank onboarding digest draft",
    );
    assert(blankDigestDraft.status === "ready", `blank onboarding digest draft status was ${blankDigestDraft.status}`);

    const blankFinalize = await fetchJson(
      `${baseUrl}/api/projects/${blankProjectId}/blank-onboarding/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          digestDraftId: blankDigestDraft.id,
          digestOutput: blankDigestGenerate.data.output,
          authorNotes: blankAuthorNotes,
          importedReferenceIds: [markdownReferenceItem.id, htmlReferenceItem.id],
          followUpAnswers: [
            {
              questionKey: "core_conflict",
              answer: blankConflictAnswer,
            },
            {
              questionKey: "world_rules",
              answer: blankWorldRulesAnswer,
            },
            {
              questionKey: "factions",
              answer: blankFactionsAnswer,
            },
            {
              questionKey: "style_research",
              answer: blankStyleAnswer,
            },
          ],
        }),
      },
      cookies,
    );
    assertOk(blankFinalize, "finalize blank onboarding project");
    assert(
      blankFinalize.data.followUpAnswerCount === 4,
      `expected 4 blank onboarding follow-up answers, got ${blankFinalize.data.followUpAnswerCount}`,
    );
    assert(
      Array.isArray(blankFinalize.data.appliedArtifactKeys) &&
        blankFinalize.data.appliedArtifactKeys.includes("project_prompt_pack") &&
        blankFinalize.data.appliedArtifactKeys.includes("project_skill_pack") &&
        blankFinalize.data.appliedArtifactKeys.includes("onboarding_brief"),
      "blank onboarding finalize did not apply the overlay artifacts.",
    );

    const blankArtifacts = await fetchJson(
      `${baseUrl}/api/projects/${blankProjectId}/artifacts`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(blankArtifacts, "list blank onboarding artifacts");

    const blankStoryBackgroundArtifact = findArtifactBy(
      blankArtifacts.data.items,
      (item) => item.artifactKey === "story_background",
      "blank story background artifact",
    );
    const blankFindingsArtifact = findArtifactBy(
      blankArtifacts.data.items,
      (item) => item.artifactKey === "findings",
      "blank findings artifact",
    );
    const blankPromptPackArtifact = findArtifactBy(
      blankArtifacts.data.items,
      (item) => item.artifactKey === "project_prompt_pack",
      "blank project prompt pack artifact",
    );
    const blankSkillPackArtifact = findArtifactBy(
      blankArtifacts.data.items,
      (item) => item.artifactKey === "project_skill_pack",
      "blank project skill pack artifact",
    );
    const blankOnboardingBriefArtifact = findArtifactBy(
      blankArtifacts.data.items,
      (item) => item.artifactKey === "onboarding_brief",
      "blank onboarding brief artifact",
    );

    assert(
      blankStoryBackgroundArtifact.currentRevision?.content?.includes(blankProjectTitle) &&
        blankStoryBackgroundArtifact.currentRevision?.content?.includes(blankConflictAnswer),
      "blank story_background did not absorb the finalized conflict summary.",
    );
    assert(
      blankFindingsArtifact.currentRevision?.content?.includes("old-ledger.md") &&
        blankFindingsArtifact.currentRevision?.content?.includes("guild-thread.html") &&
        blankFindingsArtifact.currentRevision?.content?.includes(blankMarkdownMarker) &&
        blankFindingsArtifact.currentRevision?.content?.includes(blankHtmlMarker),
      "blank findings artifact did not keep the imported materials and digest markers.",
    );
    assert(
      blankPromptPackArtifact.currentRevision?.content?.includes(blankStyleAnswer),
      "blank project_prompt_pack content was not generated from blank onboarding answers.",
    );
    assert(
      blankSkillPackArtifact.currentRevision?.content?.includes(blankConflictAnswer),
      "blank project_skill_pack content was not generated from blank onboarding answers.",
    );
    assert(
      blankOnboardingBriefArtifact.currentRevision?.content?.includes(blankFactionsAnswer),
      "blank onboarding_brief content was missing the follow-up summary.",
    );

    const providerRequestStartBeforeBlankWorkflow = providerState.requestBodies.length;
    const blankWorkflowCheck = await fetchJson(
      `${baseUrl}/api/projects/${blankProjectId}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskType: "workflow_check",
          userInstruction: "请检查 blank onboarding 后的项目骨架是否足够继续推进设定和卷纲。",
          endpointId: endpoint.data.id,
          modelId: "gpt-4o-mini",
          selectedArtifactIds: [],
          selectedReferenceIds: [],
          selectedMcpServerIds: [],
          generationOptions: {
            temperature: 0,
            maxTokens: 1200,
          },
        }),
      },
      cookies,
    );
    assertOk(blankWorkflowCheck, "blank workflow_check generate");
    assert(
      Array.isArray(blankWorkflowCheck.data.resolvedSkills) &&
        blankWorkflowCheck.data.resolvedSkills.includes("project_skill_pack"),
      "blank workflow_check resolvedSkills did not include project_skill_pack overlay.",
    );
    assert(
      Array.isArray(blankWorkflowCheck.data.resolvedArtifacts) &&
        blankWorkflowCheck.data.resolvedArtifacts.some((item) => item.artifactKey === "project_prompt_pack") &&
        blankWorkflowCheck.data.resolvedArtifacts.some((item) => item.artifactKey === "project_skill_pack"),
      "blank workflow_check resolvedArtifacts did not include project overlay artifacts.",
    );

    const blankWorkflowRequestText = providerState.requestBodies
      .slice(providerRequestStartBeforeBlankWorkflow)
      .map((body) => extractBodyText(body))
      .join("\n");
    assert(
      blankWorkflowRequestText.includes("项目专属 Prompt Overlay") && blankWorkflowRequestText.includes(blankStyleAnswer),
      "blank workflow_check provider request did not include the blank prompt overlay.",
    );
    assert(
      blankWorkflowRequestText.includes("项目专属 Skill Overlay") && blankWorkflowRequestText.includes(blankConflictAnswer),
      "blank workflow_check provider request did not include the blank skill overlay.",
    );

    console.log(
      JSON.stringify({
        baseUrl,
        providerBaseUrl,
        sessionId,
        guidedProjectId: projectId,
        aiGuidedProjectId: aiProjectId,
        blankProjectId,
        endpointId: endpoint.data.id,
        guidedDraftId: generate.data.draftId,
        guidedRunId: generate.data.runId,
        blankDigestDraftId: blankDigestGenerate.data.draftId,
        blankDigestRunId: blankDigestGenerate.data.runId,
        blankWorkflowDraftId: blankWorkflowCheck.data.draftId,
        blankWorkflowRunId: blankWorkflowCheck.data.runId,
        providerRequestCount: providerState.requestBodies.length,
      }),
    );
  } finally {
    child.kill("SIGTERM");
    await sleep(1000);

    if (!child.killed) {
      child.kill("SIGKILL");
    }

    await closeServer(providerServer);

    if (stderr.trim()) {
      process.stderr.write(stderr);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
