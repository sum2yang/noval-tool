import http from "node:http";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import process from "node:process";

const nextPort = Number(process.env.NEXT_SMOKE_PORT || 3115);
const writingProviderPort = Number(process.env.MOCK_WRITING_PROVIDER_PORT || 3125);
const analysisProviderPort = Number(process.env.MOCK_ANALYSIS_PROVIDER_PORT || 3126);
const grokPort = Number(process.env.MOCK_GROK_PORT || 3135);
const loopbackAlias = process.env.SMOKE_LOOPBACK_HOST || "localhost.localstack.cloud";

const baseUrl = `http://localhost:${nextPort}`;
const writingProviderBaseUrl = `http://${loopbackAlias}:${writingProviderPort}/v1`;
const analysisProviderBaseUrl = `http://${loopbackAlias}:${analysisProviderPort}/v1`;
const grokBaseUrl = `http://${loopbackAlias}:${grokPort}`;
const nextBin = "node_modules/next/dist/bin/next";

const referenceMarker = "九州城依河设港，秋季船期更密，夜间货栈会按照潮汐钟点安排装卸与清点税票。";
const writingBodyMarker =
  "周敬安把夜班仓位让渡条款压在税票底册上，先逼对方承认夜航窗口变窄，再谈自己要的抽成比例。";
const reviewIssueMarker = "问题：主角在逼对方亮底牌前，压价动作还可以再稳半拍。";
const researchFactMarker = "秋季船期更密，税票改革后夜航窗口更集中。";

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

  if (cookies.length) {
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
      headers: response.headers,
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
    headers: response.headers,
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
  const haystack = extractBodyText(body);
  const matches = [
    {
      taskKind: "generate_chapter",
      index: findFirstMarkerIndex(haystack, ["generate_chapter", "正文生成", "写作自检", "续写", writingBodyMarker]),
    },
    {
      taskKind: "review_content",
      index: findFirstMarkerIndex(haystack, [
        "review_content",
        "质量审查",
        "问题 -> 证据 -> 最小修法",
        reviewIssueMarker,
      ]),
    },
    {
      taskKind: "research_fact_check",
      index: findFirstMarkerIndex(haystack, [
        "research_fact_check",
        "考据与事实核查",
        researchFactMarker,
        "事实结论 + 来源",
      ]),
    },
  ]
    .filter((item) => Number.isFinite(item.index))
    .sort((left, right) => left.index - right.index);

  return matches[0]?.taskKind ?? null;
}

function buildTaskOutput(taskKind, body) {
  const bodyText = extractBodyText(body);

  if (bodyText.includes("Reply with exactly OK")) {
    return "OK";
  }

  switch (taskKind) {
    case "generate_chapter":
      return [
        "【写作自检】",
        "- 收益链：夜班仓位、税票核验、抽成比例三者已经挂钩。",
        "- 场景目标：先逼对方承认夜航窗口收紧，再压到自己想要的分成。",
        "",
        "正文",
        writingBodyMarker,
        "他没有先报数，而是等对方先把焦躁写在脸上，才顺着夜潮钟把谈判节奏收进自己手里。",
        "",
        "【建议回填】",
        "- progress.md",
        "- 99_当前状态卡.md",
      ].join("\n");
    case "review_content":
      return [
        `问题：${reviewIssueMarker.replace("问题：", "")}`,
        "证据：主角在确认对方筹码之前就开始压价，风险感还不够清晰。",
        "最小修法：先补一个核验税票底册和夜航窗口的停顿，再进入压价动作。",
      ].join("\n");
    case "research_fact_check":
      return [
        "# 考据结果",
        "",
        "## 结论",
        `- ${researchFactMarker}`,
        "",
        "## 来源摘要",
        "- Harbor Report | https://example.com/harbor-report | Steamship arrivals peaked in the autumn quarter.",
        "- Customs Bulletin | https://example.com/customs-bulletin | Import duties changed after the port inspection reform.",
        "",
        "## 可写入项目的事实补充",
        `- findings.md：${researchFactMarker}`,
      ].join("\n");
    default:
      return "Smoke response.";
  }
}

function buildResponseApiPayload(body, requestIndex) {
  const model = typeof body?.model === "string" ? body.model : "gpt-4o-mini";
  const taskKind = detectTaskKind(body);

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
            text: buildTaskOutput(taskKind, body),
            annotations: [],
          },
        ],
      },
    ],
    usage: {
      input_tokens: 56,
      output_tokens: 48,
      total_tokens: 104,
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
  const taskKind = detectTaskKind(body);
  const output = buildTaskOutput(taskKind, body);
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
        input_tokens: 56,
        input_tokens_details: {
          cached_tokens: 0,
        },
        output_tokens: 48,
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
  const taskKind = detectTaskKind(body);

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
          content: buildTaskOutput(taskKind, body),
          annotations: [],
        },
      },
    ],
    usage: {
      prompt_tokens: 56,
      completion_tokens: 48,
      total_tokens: 104,
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
    state.requests.push({
      path: url.pathname,
      taskKind: detectTaskKind(body),
      body,
      headers: {
        authorization: request.headers.authorization ?? null,
      },
    });
    const requestIndex = state.requests.length;

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

function createMockGrokServer(state) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    if (request.method !== "POST") {
      response.writeHead(405, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Method not allowed." }));
      return;
    }

    const body = await readJsonBody(request);
    state.requests.push({
      path: url.pathname,
      body,
      headers: {
        authorization: request.headers.authorization ?? null,
      },
    });

    if (url.pathname !== "/tools/web_search") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Not found." }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        sources: [
          {
            title: "Harbor Report",
            url: "https://example.com/harbor-report",
            summary: "Steamship arrivals peaked in the autumn quarter.",
          },
          {
            name: "Customs Bulletin",
            link: "https://example.com/customs-bulletin",
            description: "Import duties changed after the port inspection reform.",
          },
        ],
        meta: {
          echoedQuery: body?.payload?.query ?? null,
          echoedTaskType: body?.payload?.taskType ?? null,
        },
      }),
    );
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
  const found = Array.isArray(items) ? items.find(predicate) : null;
  if (!found) {
    throw new Error(`${label} not found.`);
  }

  return found;
}

function findRunById(items, runId, label) {
  const found = Array.isArray(items) ? items.find((item) => item.id === runId) : null;
  if (!found) {
    throw new Error(`${label} run not found.`);
  }

  return found;
}

function findDraftById(items, draftId, label) {
  const found = Array.isArray(items) ? items.find((item) => item.id === draftId) : null;
  if (!found) {
    throw new Error(`${label} draft not found.`);
  }

  return found;
}

function findProviderRequestByTask(requests, taskKind, label) {
  const found = requests.find((request) => request.taskKind === taskKind);
  if (!found) {
    throw new Error(`${label} provider request not found.`);
  }

  return found;
}

function extractMaxTokens(body) {
  return body?.max_output_tokens ?? body?.max_completion_tokens ?? body?.max_tokens ?? null;
}

async function main() {
  await ensureProductionBuild();

  const writingProviderState = { requests: [] };
  const analysisProviderState = { requests: [] };
  const grokState = { requests: [] };
  const writingProviderServer = createMockProviderServer(writingProviderState);
  const analysisProviderServer = createMockProviderServer(analysisProviderState);
  const grokServer = createMockGrokServer(grokState);

  await Promise.all([
    listen(writingProviderServer, writingProviderPort),
    listen(analysisProviderServer, analysisProviderPort),
    listen(grokServer, grokPort),
  ]);

  const child = spawn(process.execPath, [nextBin, "start", "-p", String(nextPort)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      APP_BASE_URL: baseUrl,
      BETTER_AUTH_URL: baseUrl,
      GROK_API_URL: grokBaseUrl,
      GROK_API_KEY: "grok-smoke-key",
      GROK_MODEL: "grok-smoke-model",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer();

    const signup = await fetchJson(`${baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Smoke API Preset Tester",
        email: `smoke-api-presets-${Date.now()}@example.com`,
        password: "Passw0rd123!",
      }),
    });
    assertOk(signup, "signup");
    assert(signup.cookies.length > 0, "signup succeeded but no session cookie was returned.");

    const cookies = signup.cookies;
    const project = await fetchJson(
      `${baseUrl}/api/projects`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Smoke API Preset Project",
          genre: "历史商战",
          platform: "起点",
          status: "active",
        }),
      },
      cookies,
    );
    assertOk(project, "project creation");

    const projectId = project.data.project.id;

    const artifactsInitial = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(artifactsInitial, "initial artifacts");

    const chapterArtifact = findArtifactBy(
      artifactsInitial.data.items,
      (item) => item.kind === "project_chapter",
      "initial chapter artifact",
    );

    const referenceForm = new FormData();
    referenceForm.set(
      "file",
      new File([`# 港口考据笔记\n\n${referenceMarker}`], "api-preset-reference.md", {
        type: "text/markdown",
      }),
    );
    referenceForm.set("tags", "港口, 考据");
    referenceForm.set("sourceUrl", "https://example.com/api-preset-reference");

    const referenceCreate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/references`,
      {
        method: "POST",
        body: referenceForm,
      },
      cookies,
    );
    assertOk(referenceCreate, "reference upload");
    const referenceItem = referenceCreate.data.items?.[0];
    assert(referenceItem, "reference upload did not return the uploaded reference item.");
    const referenceId = referenceItem.id;

    const writingEndpoint = await fetchJson(
      `${baseUrl}/api/provider-endpoints`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerType: "openai",
          label: "Writing Preset Endpoint",
          baseURL: writingProviderBaseUrl,
          authMode: "bearer",
          secret: "sk-writing-smoke-key",
          extraHeaders: {},
          defaultModel: "writer-default",
        }),
      },
      cookies,
    );
    assertOk(writingEndpoint, "writing endpoint creation");

    const analysisEndpoint = await fetchJson(
      `${baseUrl}/api/provider-endpoints`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerType: "openai",
          label: "Analysis Preset Endpoint",
          baseURL: analysisProviderBaseUrl,
          authMode: "bearer",
          secret: "sk-analysis-smoke-key",
          extraHeaders: {},
          defaultModel: "analysis-default",
        }),
      },
      cookies,
    );
    assertOk(analysisEndpoint, "analysis endpoint creation");

    const backupPresetConfig = {
      presetKey: "backup-writer",
      label: "备用写作",
      endpointId: writingEndpoint.data.id,
      modelId: "writer-backup-model",
      taskType: "generate_setting",
      temperature: 0.45,
      maxTokens: 1100,
    };
    const writingPresetConfig = {
      presetKey: "chapter-fast",
      label: "章节快写",
      endpointId: writingEndpoint.data.id,
      modelId: "writer-model",
      taskType: "generate_chapter",
      temperature: 0.81,
      maxTokens: 1501,
    };
    const reviewPresetConfig = {
      presetKey: "deep-review",
      label: "深度审稿",
      endpointId: analysisEndpoint.data.id,
      modelId: "reviewer-model",
      taskType: "review_content",
      temperature: 0.22,
      maxTokens: 901,
    };
    const researchPresetConfig = {
      presetKey: "harbor-research",
      label: "港口考据",
      endpointId: analysisEndpoint.data.id,
      modelId: "researcher-model",
      taskType: "research_fact_check",
      temperature: 0,
      maxTokens: 701,
    };

    const projectPreferenceUpdate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          defaultEndpointId: writingEndpoint.data.id,
          defaultModel: "writer-model",
          defaultTaskType: "generate_chapter",
          activeChapterArtifactId: chapterArtifact.id,
          apiPresets: [backupPresetConfig, writingPresetConfig, reviewPresetConfig, researchPresetConfig],
        }),
      },
      cookies,
    );
    assertOk(projectPreferenceUpdate, "project preference update");

    const projectPreferenceReorder = await fetchJson(
      `${baseUrl}/api/projects/${projectId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          defaultEndpointId: writingEndpoint.data.id,
          defaultModel: "writer-model",
          defaultTaskType: "generate_chapter",
          activeChapterArtifactId: chapterArtifact.id,
          apiPresets: [reviewPresetConfig, writingPresetConfig, researchPresetConfig],
        }),
      },
      cookies,
    );
    assertOk(projectPreferenceReorder, "project preference reorder");

    const projectDetail = await fetchJson(`${baseUrl}/api/projects/${projectId}`, { method: "GET" }, cookies);
    assertOk(projectDetail, "project detail");
    const apiPresets = projectDetail.data.preference?.apiPresets ?? [];
    assert(apiPresets.length === 3, "project api presets were not persisted.");
    assert(apiPresets[0]?.presetKey === "deep-review", "reordered review preset was not persisted first.");
    assert(apiPresets[1]?.presetKey === "chapter-fast", "reordered writing preset was not persisted second.");
    assert(apiPresets[2]?.presetKey === "harbor-research", "reordered research preset was not persisted third.");
    assert(apiPresets[0]?.modelId === "reviewer-model", "review preset model was not persisted.");
    assert(apiPresets[1]?.taskType === "generate_chapter", "writing preset task type was not persisted.");
    assert(apiPresets[2]?.maxTokens === 701, "research preset maxTokens was not persisted.");

    const writingGenerate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskType: writingPresetConfig.taskType,
          userInstruction: "请根据写作预设续写当前章节，重点写夜班仓位谈判。",
          endpointId: writingPresetConfig.endpointId,
          modelId: writingPresetConfig.modelId,
          targetArtifactId: chapterArtifact.id,
          selectedArtifactIds: [],
          selectedReferenceIds: [],
          selectedMcpServerIds: [],
          generationOptions: {
            temperature: writingPresetConfig.temperature,
            maxTokens: writingPresetConfig.maxTokens,
          },
        }),
      },
      cookies,
    );
    assertOk(writingGenerate, "writing preset generate");
    assert(
      writingGenerate.data.output.includes(writingBodyMarker),
      "writing preset output did not include the writing marker.",
    );

    const writingAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts/${writingGenerate.data.draftId}/accept`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          artifactId: chapterArtifact.id,
          summary: "Smoke API preset writing accept",
        }),
      },
      cookies,
    );
    assertOk(writingAccept, "writing draft accept");

    const chapterAfterAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${chapterArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(chapterAfterAccept, "chapter after writing accept");
    assert(
      chapterAfterAccept.data.currentRevision?.content?.includes(writingBodyMarker),
      "accepted chapter revision did not contain the writing output.",
    );

    const reviewGenerate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskType: reviewPresetConfig.taskType,
          userInstruction: "请根据审稿预设审查当前章节，输出问题、证据和最小修法。",
          endpointId: reviewPresetConfig.endpointId,
          modelId: reviewPresetConfig.modelId,
          selectedArtifactIds: [chapterArtifact.id],
          selectedReferenceIds: [],
          selectedMcpServerIds: [],
          generationOptions: {
            temperature: reviewPresetConfig.temperature,
            maxTokens: reviewPresetConfig.maxTokens,
          },
        }),
      },
      cookies,
    );
    assertOk(reviewGenerate, "review preset generate");
    assert(
      reviewGenerate.data.output.includes(reviewIssueMarker),
      "review preset output did not include the review marker.",
    );

    const researchGenerate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskType: researchPresetConfig.taskType,
          userInstruction: "请根据考据预设核查夜航窗口与税票改革的关系。",
          endpointId: researchPresetConfig.endpointId,
          modelId: researchPresetConfig.modelId,
          selectedArtifactIds: [],
          selectedReferenceIds: [referenceId],
          selectedMcpServerIds: [],
          generationOptions: {
            temperature: researchPresetConfig.temperature,
            maxTokens: researchPresetConfig.maxTokens,
          },
        }),
      },
      cookies,
    );
    assertOk(researchGenerate, "research preset generate");
    assert(
      researchGenerate.data.output.includes(researchFactMarker),
      "research preset output did not include the research marker.",
    );

    const writingRequest = findProviderRequestByTask(
      writingProviderState.requests,
      "generate_chapter",
      "writing preset",
    );
    assert(writingRequest.body?.model === "writer-model", "writing preset model did not reach the writing provider.");
    assert(writingRequest.body?.temperature === 0.81, "writing preset temperature did not reach the writing provider.");
    assert(extractMaxTokens(writingRequest.body) === 1501, "writing preset maxTokens did not reach the writing provider.");

    const reviewRequest = findProviderRequestByTask(
      analysisProviderState.requests,
      "review_content",
      "review preset",
    );
    assert(reviewRequest.body?.model === "reviewer-model", "review preset model did not reach the analysis provider.");
    assert(reviewRequest.body?.temperature === 0.22, "review preset temperature did not reach the analysis provider.");
    assert(extractMaxTokens(reviewRequest.body) === 901, "review preset maxTokens did not reach the analysis provider.");

    const researchRequest = findProviderRequestByTask(
      analysisProviderState.requests,
      "research_fact_check",
      "research preset",
    );
    assert(
      researchRequest.body?.model === "researcher-model",
      "research preset model did not reach the analysis provider.",
    );
    assert(
      researchRequest.body?.temperature === 0,
      "research preset temperature did not reach the analysis provider.",
    );
    assert(extractMaxTokens(researchRequest.body) === 701, "research preset maxTokens did not reach the analysis provider.");

    const drafts = await fetchJson(`${baseUrl}/api/projects/${projectId}/drafts`, { method: "GET" }, cookies);
    assertOk(drafts, "draft listing");
    const reviewDraft = findDraftById(drafts.data.items, reviewGenerate.data.draftId, "review preset");
    const researchDraft = findDraftById(drafts.data.items, researchGenerate.data.draftId, "research preset");
    assert(reviewDraft.draftKind === "review_revision", "review preset draftKind was not review_revision.");
    assert(researchDraft.taskType === "research_fact_check", "research preset draft taskType did not persist.");

    const runs = await fetchJson(`${baseUrl}/api/projects/${projectId}/runs`, { method: "GET" }, cookies);
    assertOk(runs, "run listing");
    const writingRun = findRunById(runs.data.items, writingGenerate.data.runId, "writing preset");
    const reviewRun = findRunById(runs.data.items, reviewGenerate.data.runId, "review preset");
    const researchRun = findRunById(runs.data.items, researchGenerate.data.runId, "research preset");

    assert(writingRun.endpointId === writingEndpoint.data.id, "writing preset run endpointId did not persist.");
    assert(writingRun.modelId === "writer-model", "writing preset run modelId did not persist.");
    assert(reviewRun.endpointId === analysisEndpoint.data.id, "review preset run endpointId did not persist.");
    assert(reviewRun.modelId === "reviewer-model", "review preset run modelId did not persist.");
    assert(researchRun.endpointId === analysisEndpoint.data.id, "research preset run endpointId did not persist.");
    assert(researchRun.modelId === "researcher-model", "research preset run modelId did not persist.");
    assert(
      researchRun.toolCallsSummary?.externalSearch?.status === "ok",
      "research preset run did not persist externalSearch tool summary.",
    );

    assert(grokState.requests.length === 1, "research preset did not trigger exactly one Grok search request.");
    assert(
      grokState.requests[0]?.body?.payload?.taskType === "research_fact_check",
      "research preset Grok payload did not carry the research task type.",
    );

    console.log(
      JSON.stringify({
        baseUrl,
        projectId,
        writingEndpointId: writingEndpoint.data.id,
        analysisEndpointId: analysisEndpoint.data.id,
        writingRunId: writingGenerate.data.runId,
        reviewRunId: reviewGenerate.data.runId,
        researchRunId: researchGenerate.data.runId,
        writingProviderRequestCount: writingProviderState.requests.length,
        analysisProviderRequestCount: analysisProviderState.requests.length,
        grokRequestCount: grokState.requests.length,
      }),
    );
  } finally {
    child.kill("SIGTERM");
    await sleep(1000);

    if (!child.killed) {
      child.kill("SIGKILL");
    }

    await Promise.all([
      closeServer(writingProviderServer),
      closeServer(analysisProviderServer),
      closeServer(grokServer),
    ]);

    if (stderr.trim()) {
      process.stderr.write(stderr);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
