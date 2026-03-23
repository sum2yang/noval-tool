import http from "node:http";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import process from "node:process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const nextPort = Number(process.env.NEXT_SMOKE_PORT || 3108);
const providerPort = Number(process.env.MOCK_PROVIDER_PORT || 3118);
const mcpPort = Number(process.env.MOCK_MCP_PORT || 3128);
const loopbackAlias = process.env.SMOKE_LOOPBACK_HOST || "localhost.localstack.cloud";

const baseUrl = `http://localhost:${nextPort}`;
const providerBaseUrl = `http://${loopbackAlias}:${providerPort}/v1`;
const mcpServerUrl = `http://${loopbackAlias}:${mcpPort}/mcp`;
const nextBin = "node_modules/next/dist/bin/next";
const secondChapterTitle = "第二章 港口夜谈";
const chapterGuidanceLabel = "【本章推进摘要】";
const chapterGuidanceAnswer = "这一章先让旧商会把夜班仓位压力压上来，逼主角在现金流、盟友和底牌之间选边。";
const chapterGuidanceEphemeralLine = "这段摘要只作用于当前 run / 当前 draft，不得直接覆盖长期设定文件。";

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
  const nextCookies = parseSetCookie(setCookie);
  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return {
    status: response.status,
    data,
    cookies: nextCookies,
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
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function buildGuidedChapterInstruction(baseInstruction, chapterTitle) {
  return [
    baseInstruction,
    "",
    chapterGuidanceLabel,
    `章节：${chapterTitle}`,
    `作者本次选择：${chapterGuidanceAnswer}`,
    "生成要求：先围绕这条推进线组织本章目标、冲突升级、信息揭示和章节钩子。",
    chapterGuidanceEphemeralLine,
  ].join("\n");
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
      index: findFirstMarkerIndex(haystack, ["generate_chapter", "正文生成", "写作自检", "续写"]),
    },
    {
      taskKind: "review_content",
      index: findFirstMarkerIndex(haystack, ["review_content", "质量审查", "问题 -> 证据 -> 最小修法", "审稿", "问题："]),
    },
    {
      taskKind: "minimal_fix",
      index: findFirstMarkerIndex(haystack, ["minimal_fix", "最小修法改写", "修改后的文本", "修改摘要"]),
    },
  ]
    .filter((item) => Number.isFinite(item.index))
    .sort((left, right) => left.index - right.index);

  return matches[0]?.taskKind ?? null;
}

function getFirstResponseToolName(body) {
  if (!Array.isArray(body?.tools)) {
    return null;
  }

  const tool = body.tools.find((item) => item?.type === "function" && typeof item.name === "string");
  return tool?.name ?? null;
}

function getFirstChatToolName(body) {
  if (!Array.isArray(body?.tools)) {
    return null;
  }

  const tool = body.tools.find((item) => item?.type === "function" && typeof item.function?.name === "string");
  return tool?.function?.name ?? null;
}

function getResponseToolResult(body) {
  if (!Array.isArray(body?.input)) {
    return null;
  }

  return body.input.find((item) => item?.type === "function_call_output") ?? null;
}

function getChatToolResult(body) {
  if (!Array.isArray(body?.messages)) {
    return null;
  }

  return body.messages.find((message) => message?.role === "tool") ?? null;
}

function buildTaskOutput(taskKind, toolOutput) {
  const factLine =
    typeof toolOutput === "string" && toolOutput.trim()
      ? toolOutput.trim()
      : "Smoke fact for 九州城的贸易港背景: 九州城依河设港，商旅与船运共同塑造市井气。";

  switch (taskKind) {
    case "generate_chapter":
      return [
        "【写作自检】",
        "- 连续性：延续当前港口商战线索。",
        `- 事实锚点：${factLine}`,
        "",
        "正文",
        "周敬安站在潮钟下，先核对夜班仓单和靠港时刻，确认这批货确实会在三更前卸下。",
        "他没有立刻压价，而是顺着栈桥把第七码头到第九码头都走了一遍，等到对方露出急色，才开口谈优先仓位和抽成。",
        "",
        "【建议回填】",
        "- progress.md",
        "- 99_当前状态卡.md",
      ].join("\n");
    case "review_content":
      return [
        "问题：主角在确认利益交换前推进得还是偏快。",
        `证据：当前稿件已经写到“先核对夜班仓单和靠港时刻”，但在 ${factLine} 之后还缺一拍让主角确认仓位让渡条件。`,
        "最小修法：在主角开口谈价前，加一句他先确认对方愿意让出优先仓位，再决定压价入局。",
      ].join("\n");
    case "minimal_fix":
      return [
        "周敬安站在潮钟下，先核对夜班仓单和靠港时刻，确认这批货确实会在三更前卸下。",
        "他没有立刻压价，而是顺着栈桥把第七码头到第九码头都走了一遍，又盯着对方让出来的优先仓位凭据看了两遍，确认好处落袋，才开口谈抽成。",
        "",
        "修改摘要：补入主角确认优先仓位的动作，让决策链条更完整。",
        "建议回填项：progress.md / 99_当前状态卡.md",
      ].join("\n");
    default:
      return "OK";
  }
}

function buildResponseApiPayload(body, requestIndex, state) {
  const model = typeof body?.model === "string" ? body.model : "gpt-4o-mini";
  const toolResult = getResponseToolResult(body);
  const toolName = getFirstResponseToolName(body);
  const detectedTaskKind = detectTaskKind(body);

  if (toolResult) {
    const taskKind = detectedTaskKind ?? state.taskByCallId.get(toolResult.call_id) ?? "review_content";

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
              text: buildTaskOutput(taskKind, toolResult.output),
              annotations: [],
            },
          ],
        },
      ],
      usage: {
        input_tokens: 64,
        output_tokens: 48,
        total_tokens: 112,
      },
    };
  }

  if (toolName) {
    const callId = `call_${requestIndex}`;
    state.taskByCallId.set(callId, detectedTaskKind ?? "review_content");

    return {
      id: `resp_${requestIndex}`,
      created_at: Math.floor(Date.now() / 1000),
      model,
      output: [
        {
          type: "function_call",
          id: `fc_${requestIndex}`,
          call_id: callId,
          name: toolName,
          arguments: JSON.stringify({
            topic: "九州城的贸易港背景",
          }),
        },
      ],
      usage: {
        input_tokens: 32,
        output_tokens: 10,
        total_tokens: 42,
      },
    };
  }

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
            text: buildTaskOutput(detectedTaskKind, null),
            annotations: [],
          },
        ],
      },
    ],
    usage: {
      input_tokens: 24,
      output_tokens: 18,
      total_tokens: 42,
    },
  };
}

function buildChatCompletionPayload(body, requestIndex, state) {
  const model = typeof body?.model === "string" ? body.model : "gpt-4o-mini";
  const toolResult = getChatToolResult(body);
  const toolName = getFirstChatToolName(body);
  const detectedTaskKind = detectTaskKind(body);

  if (toolResult) {
    const taskKind = detectedTaskKind ?? state.taskByCallId.get(toolResult.tool_call_id) ?? "review_content";

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
            content: buildTaskOutput(taskKind, toolResult.content),
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

  if (toolName) {
    const callId = `call_${requestIndex}`;
    state.taskByCallId.set(callId, detectedTaskKind ?? "review_content");

    return {
      id: `chatcmpl_${requestIndex}`,
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: callId,
                type: "function",
                function: {
                  name: toolName,
                  arguments: JSON.stringify({
                    topic: "九州城的贸易港背景",
                  }),
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 32,
        completion_tokens: 10,
        total_tokens: 42,
      },
    };
  }

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
          content: buildTaskOutput(detectedTaskKind, null),
          annotations: [],
        },
      },
    ],
    usage: {
      prompt_tokens: 24,
      completion_tokens: 18,
      total_tokens: 42,
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
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(buildResponseApiPayload(body, requestIndex, state)));
      return;
    }

    if (url.pathname === "/v1/chat/completions") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(buildChatCompletionPayload(body, requestIndex, state)));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not found." }));
  });
}

function createMockMcpInstance() {
  const server = new McpServer({
    name: "smoke-mcp-server",
    version: "1.0.0",
  });

  server.registerTool(
    "lookup_fact",
    {
      description: "Return a deterministic fact snippet for smoke testing.",
      inputSchema: {
        topic: z.string(),
      },
    },
    async ({ topic }) => ({
      content: [
        {
          type: "text",
          text: `Smoke fact for ${topic}: 九州城依河设港，商旅与船运共同塑造市井气。`,
        },
      ],
    }),
  );

  server.registerPrompt(
    "review_with_fact",
    {
      description: "Prompt stub used to verify MCP prompt discovery.",
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "请在输出前先调用 lookup_fact。",
          },
        },
      ],
    }),
  );

  server.registerResource(
    "smoke_reference",
    "https://example.com/smoke/reference",
    {
      mimeType: "text/plain",
    },
    async () => ({
      contents: [
        {
          uri: "https://example.com/smoke/reference",
          text: "Smoke MCP resource body.",
        },
      ],
    }),
  );

  return server;
}

function createMockMcpServer(state) {
  return http.createServer(async (request, response) => {
    state.requestCount += 1;

    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname !== "/mcp") {
      response.writeHead(404).end("Not found.");
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const server = createMockMcpInstance();

      await server.connect(transport);

      response.on("close", () => {
        void transport.close();
        void server.close();
      });

      await transport.handleRequest(request, response, body);
      return;
    }

    response.writeHead(405, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed.",
        },
        id: null,
      }),
    );
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
    taskByCallId: new Map(),
  };
  const mcpState = {
    requestCount: 0,
  };

  const providerServer = createMockProviderServer(providerState);
  const mcpServer = createMockMcpServer(mcpState);

  await Promise.all([listen(providerServer, providerPort), listen(mcpServer, mcpPort)]);

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

    const email = `smoke-mcp-e2e-${Date.now()}@example.com`;
    const signup = await fetchJson(`${baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Smoke MCP E2E Tester",
        email,
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
          name: "Smoke MCP E2E Project",
          genre: "玄幻",
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

    const initialChapterArtifact = findArtifactBy(
      artifactsInitial.data.items,
      (item) => item.kind === "project_chapter",
      "initial chapter artifact",
    );
    const findingsArtifact = findArtifactBy(
      artifactsInitial.data.items,
      (item) => item.filename === "findings.md",
      "findings artifact",
    );
    const progressArtifact = findArtifactBy(
      artifactsInitial.data.items,
      (item) => item.filename === "progress.md",
      "progress artifact",
    );
    const currentStateArtifact = findArtifactBy(
      artifactsInitial.data.items,
      (item) => item.filename === "99_当前状态卡.md",
      "current state artifact",
    );

    const createChapter = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chapterTitle: secondChapterTitle,
        }),
      },
      cookies,
    );
    assertOk(createChapter, "chapter creation");
    assert(createChapter.data.artifact.kind === "project_chapter", "created artifact was not a project_chapter.");

    const secondChapterArtifactId = createChapter.data.artifact.id;
    const switchChapter = await fetchJson(
      `${baseUrl}/api/projects/${projectId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          activeChapterArtifactId: secondChapterArtifactId,
        }),
      },
      cookies,
    );
    assertOk(switchChapter, "active chapter update");
    assert(
      switchChapter.data.preference.activeChapterArtifactId === secondChapterArtifactId,
      "activeChapterArtifactId did not switch to the new chapter.",
    );

    const projectAfterSwitch = await fetchJson(
      `${baseUrl}/api/projects/${projectId}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(projectAfterSwitch, "project after chapter switch");
    assert(
      projectAfterSwitch.data.preference.activeChapterArtifactId === secondChapterArtifactId,
      "persisted activeChapterArtifactId did not match the switched chapter.",
    );

    const referenceForm = new FormData();
    referenceForm.set(
      "file",
      new File(
        [
          "# 港口设定\n\n九州城依河设港，夜间货栈以潮汐钟点安排装卸。",
        ],
        "harbor-notes.md",
        { type: "text/markdown" },
      ),
    );
    referenceForm.set("tags", "港口, 贸易");
    referenceForm.set("sourceUrl", "https://example.com/harbor-notes");

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

    const endpoint = await fetchJson(
      `${baseUrl}/api/provider-endpoints`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerType: "openai",
          label: "Mock OpenAI Smoke E2E",
          baseURL: providerBaseUrl,
          authMode: "none",
          extraHeaders: {},
          defaultModel: "gpt-4o-mini",
        }),
      },
      cookies,
    );
    assertOk(endpoint, "endpoint creation");

    const endpointId = endpoint.data.id;
    const providerHealth = await fetchJson(
      `${baseUrl}/api/provider-endpoints/${endpointId}/health`,
      {
        method: "POST",
      },
      cookies,
    );
    assertOk(providerHealth, "provider health probe");
    assert(providerHealth.data.status === "healthy", `provider health was ${providerHealth.data.status}`);

    const mcpRegistration = await fetchJson(
      `${baseUrl}/api/mcp-servers`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Smoke MCP E2E",
          transportType: "streamable_http",
          serverUrl: mcpServerUrl,
          authMode: "none",
          extraHeaders: {},
        }),
      },
      cookies,
    );
    assertOk(mcpRegistration, "mcp registration");

    const mcpId = mcpRegistration.data.id;
    const mcpHealth = await fetchJson(
      `${baseUrl}/api/mcp-servers/${mcpId}/health`,
      {
        method: "POST",
      },
      cookies,
    );
    assertOk(mcpHealth, "mcp health probe");
    assert(mcpHealth.data.status === "healthy", `mcp health was ${mcpHealth.data.status}`);

    const autosaveSeed = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          artifactId: secondChapterArtifactId,
          taskType: "generate_chapter",
          outputContent: "AUTOSAVE_SEED_MARKER：周敬安在港口账房外停步，先把潮钟和仓单都核了一遍。",
          suggestedPatches: [],
          status: "pending",
          draftKind: "editor_autosave",
          runId: null,
        }),
      },
      cookies,
    );
    assertOk(autosaveSeed, "chapter autosave seed");
    assert(autosaveSeed.data.artifactId === secondChapterArtifactId, "autosave draft did not bind to the active chapter.");

    const chapterRejectRequestStart = providerState.requestBodies.length;
    const chapterGenerateReject = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskType: "generate_chapter",
          userInstruction: "请结合港口事实续写当前章节。",
          endpointId,
          modelId: "gpt-4o-mini",
          targetArtifactId: secondChapterArtifactId,
          selectedArtifactIds: [],
          selectedReferenceIds: [referenceItem.id],
          selectedMcpServerIds: [mcpId],
          generationOptions: {
            temperature: 0,
          },
        }),
      },
      cookies,
    );
    assertOk(chapterGenerateReject, "chapter generate draft for reject");
    assert(
      String(chapterGenerateReject.data.output).includes("【写作自检】"),
      `chapter generate output did not contain the expected chapter contract. Received: ${JSON.stringify(chapterGenerateReject.data.output)}`,
    );
    const chapterRejectRequests = providerState.requestBodies.slice(chapterRejectRequestStart);
    assert(
      chapterRejectRequests.every((body) => !extractBodyText(body).includes(chapterGuidanceLabel)),
      "direct chapter generation unexpectedly included the guidance brief marker.",
    );

    const rejectChapterDraft = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts/${chapterGenerateReject.data.draftId}/reject`,
      {
        method: "POST",
      },
      cookies,
    );
    assertOk(rejectChapterDraft, "chapter draft reject");
    assert(rejectChapterDraft.data.draft.status === "rejected", "chapter draft reject did not persist rejected status.");
    assert(rejectChapterDraft.data.chapter?.status === "draft", "chapter status did not return to draft after reject.");

    const chapterAcceptRequestStart = providerState.requestBodies.length;
    const chapterGenerateAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskType: "generate_chapter",
          userInstruction: buildGuidedChapterInstruction(
            "请结合港口事实续写当前章节，并保持收益交换链完整。",
            secondChapterTitle,
          ),
          endpointId,
          modelId: "gpt-4o-mini",
          targetArtifactId: secondChapterArtifactId,
          selectedArtifactIds: [],
          selectedReferenceIds: [referenceItem.id],
          selectedMcpServerIds: [mcpId],
          generationOptions: {
            temperature: 0,
          },
        }),
      },
      cookies,
    );
    assertOk(chapterGenerateAccept, "chapter generate draft for accept");
    const chapterAcceptRequests = providerState.requestBodies.slice(chapterAcceptRequestStart);
    assert(
      chapterAcceptRequests.some((body) => extractBodyText(body).includes(chapterGuidanceLabel)),
      "guided chapter generation did not include the guidance brief marker.",
    );
    assert(
      chapterAcceptRequests.some((body) => extractBodyText(body).includes(chapterGuidanceAnswer)),
      "guided chapter generation did not include the selected guidance answer.",
    );
    assert(
      chapterAcceptRequests.some((body) => extractBodyText(body).includes(chapterGuidanceEphemeralLine)),
      "guided chapter generation did not include the ephemeral guidance scope line.",
    );

    const acceptChapterDraft = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts/${chapterGenerateAccept.data.draftId}/accept`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          artifactId: secondChapterArtifactId,
          summary: "Smoke chapter accept revision",
        }),
      },
      cookies,
    );
    assertOk(acceptChapterDraft, "chapter draft accept");
    assert(
      acceptChapterDraft.data.chapter?.status === "accepted",
      "chapter accept did not update chapterIndex status to accepted.",
    );

    const chapterArtifactAfterAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${secondChapterArtifactId}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(chapterArtifactAfterAccept, "chapter artifact after accept");
    assert(
      chapterArtifactAfterAccept.data.currentRevision?.content === chapterGenerateAccept.data.output,
      "accepted chapter revision did not match the generated chapter draft.",
    );
    assert(
      !chapterArtifactAfterAccept.data.currentRevision?.content?.includes(chapterGuidanceLabel) &&
        !chapterArtifactAfterAccept.data.currentRevision?.content?.includes(chapterGuidanceAnswer),
      "guided chapter brief leaked into the accepted chapter revision content.",
    );

    const autosaveForReview = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          artifactId: secondChapterArtifactId,
          taskType: "generate_chapter",
          outputContent: "AUTOSAVE_REVIEW_MARKER：周敬安没有立刻谈价，而是先核对了让渡的优先仓位凭据。",
          suggestedPatches: [],
          status: "pending",
          draftKind: "editor_autosave",
          runId: null,
        }),
      },
      cookies,
    );
    assertOk(autosaveForReview, "chapter autosave update for review");
    assert(autosaveForReview.data.id === autosaveSeed.data.id, "autosave update did not reuse the existing draft record.");

    const secondChapterFilename = createChapter.data.artifact.filename;
    const autosaveReviewMarker = "AUTOSAVE_REVIEW_MARKER";
    const reviewIssueMarker = "问题：主角在确认利益交换前推进得还是偏快。";

    const reviewRejectRequestStart = providerState.requestBodies.length;
    const reviewGenerateReject = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskType: "review_content",
          userInstruction: "请先调用可用工具，再按问题、证据、最小修法审查当前章节。",
          endpointId,
          modelId: "gpt-4o-mini",
          selectedArtifactIds: [secondChapterArtifactId],
          selectedReferenceIds: [referenceItem.id],
          selectedMcpServerIds: [mcpId],
          generationOptions: {
            temperature: 0,
          },
        }),
      },
      cookies,
    );
    assertOk(reviewGenerateReject, "review draft for reject");
    assert(
      typeof reviewGenerateReject.data.output === "string" &&
        reviewGenerateReject.data.output.includes("问题：") &&
        reviewGenerateReject.data.output.includes("最小修法："),
      "review generate output did not match the expected review contract.",
    );

    const reviewRejectRequests = providerState.requestBodies.slice(reviewRejectRequestStart);
    assert(
      reviewRejectRequests.some((body) => extractBodyText(body).includes(autosaveReviewMarker)),
      "review generation did not include the latest autosave chapter content.",
    );

    const rejectReviewDraft = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts/${reviewGenerateReject.data.draftId}/reject`,
      {
        method: "POST",
      },
      cookies,
    );
    assertOk(rejectReviewDraft, "review draft reject");
    assert(rejectReviewDraft.data.draft.status === "rejected", "review reject did not persist rejected status.");

    const reviewAcceptRequestStart = providerState.requestBodies.length;
    const reviewGenerateAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskType: "review_content",
          userInstruction: "请先调用可用工具，再按问题、证据、最小修法审查当前章节，重点看利益交换链。",
          endpointId,
          modelId: "gpt-4o-mini",
          selectedArtifactIds: [secondChapterArtifactId],
          selectedReferenceIds: [referenceItem.id],
          selectedMcpServerIds: [mcpId],
          generationOptions: {
            temperature: 0,
          },
        }),
      },
      cookies,
    );
    assertOk(reviewGenerateAccept, "review draft for accept");
    assert(
      Array.isArray(reviewGenerateAccept.data.suggestedPatches) &&
        reviewGenerateAccept.data.suggestedPatches.includes("findings.md"),
      "review generate did not suggest findings.md as a patch target.",
    );

    const reviewAcceptRequests = providerState.requestBodies.slice(reviewAcceptRequestStart);
    assert(
      reviewAcceptRequests.some((body) => extractBodyText(body).includes(autosaveReviewMarker)),
      "accepted review generation did not include the latest autosave chapter content.",
    );

    const findingsBeforeAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${findingsArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(findingsBeforeAccept, "findings before review accept");
    const previousFindingsRevisionId = findingsBeforeAccept.data.currentRevision?.id ?? null;
    const previousFindingsRevisionCount = Array.isArray(findingsBeforeAccept.data.revisions)
      ? findingsBeforeAccept.data.revisions.length
      : 0;

    const acceptReviewDraft = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts/${reviewGenerateAccept.data.draftId}/accept`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          artifactId: findingsArtifact.id,
          summary: "Smoke review accept revision",
        }),
      },
      cookies,
    );
    assertOk(acceptReviewDraft, "review draft accept");

    const findingsAfterAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${findingsArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(findingsAfterAccept, "findings after review accept");
    assert(
      findingsAfterAccept.data.currentRevision?.id === acceptReviewDraft.data.id,
      "review accept did not update findings currentRevision.",
    );
    assert(
      findingsAfterAccept.data.currentRevision?.id !== previousFindingsRevisionId,
      "findings currentRevision id did not change after review accept.",
    );
    assert(
      findingsAfterAccept.data.currentRevision?.content === reviewGenerateAccept.data.output,
      "accepted review revision content did not match the generated review draft.",
    );
    assert(
      findingsAfterAccept.data.currentRevision?.summary === "Smoke review accept revision",
      "review accept summary did not persist on findings revision.",
    );
    assert(
      (Array.isArray(findingsAfterAccept.data.revisions) ? findingsAfterAccept.data.revisions.length : 0) >=
        previousFindingsRevisionCount + 1,
      "findings revision list did not grow after review accept.",
    );

    const minimalFixRequestStart = providerState.requestBodies.length;
    const minimalFixGenerate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskType: "minimal_fix",
          userInstruction: [
            "请根据以下已确认审稿意见做最小修法，不要扩写，也不要改动未确认片段。",
            "",
            reviewGenerateAccept.data.output,
          ].join("\n"),
          endpointId,
          modelId: "gpt-4o-mini",
          targetArtifactId: secondChapterArtifactId,
          selectedArtifactIds: [findingsArtifact.id, currentStateArtifact.id],
          selectedReferenceIds: [],
          selectedMcpServerIds: [],
          generationOptions: {
            temperature: 0,
          },
        }),
      },
      cookies,
    );
    assertOk(minimalFixGenerate, "minimal fix generate");
    assert(
      typeof minimalFixGenerate.data.output === "string" &&
        minimalFixGenerate.data.output.includes("修改摘要：") &&
        minimalFixGenerate.data.output.includes("建议回填项："),
      "minimal fix output did not match the expected contract.",
    );

    const minimalFixRequests = providerState.requestBodies.slice(minimalFixRequestStart);
    assert(
      minimalFixRequests.some((body) => extractBodyText(body).includes(reviewIssueMarker)),
      "minimal fix generation did not include the accepted review findings in its request context.",
    );

    const projectBeforeMinimalFixAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(projectBeforeMinimalFixAccept, "project before minimal fix accept");
    const previousProjectUpdatedAt = Date.parse(projectBeforeMinimalFixAccept.data.updatedAt);

    const chapterBeforeMinimalFixAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${secondChapterArtifactId}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(chapterBeforeMinimalFixAccept, "chapter before minimal fix accept");
    const previousChapterRevisionId = chapterBeforeMinimalFixAccept.data.currentRevision?.id ?? null;
    const previousChapterRevisionCount = Array.isArray(chapterBeforeMinimalFixAccept.data.revisions)
      ? chapterBeforeMinimalFixAccept.data.revisions.length
      : 0;

    const acceptMinimalFixDraft = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts/${minimalFixGenerate.data.draftId}/accept`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          artifactId: secondChapterArtifactId,
          summary: "Smoke minimal fix accept revision",
        }),
      },
      cookies,
    );
    assertOk(acceptMinimalFixDraft, "minimal fix draft accept");
    assert(
      acceptMinimalFixDraft.data.chapter?.status === "accepted",
      "minimal fix accept did not leave the chapter in accepted status.",
    );

    const chapterAfterMinimalFixAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${secondChapterArtifactId}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(chapterAfterMinimalFixAccept, "chapter after minimal fix accept");
    const finalChapterRevision = chapterAfterMinimalFixAccept.data.currentRevision;
    const finalChapterRevisions = Array.isArray(chapterAfterMinimalFixAccept.data.revisions)
      ? chapterAfterMinimalFixAccept.data.revisions
      : [];

    assert(finalChapterRevision, "chapter currentRevision was not available after minimal fix accept.");
    assert(
      finalChapterRevision.id === acceptMinimalFixDraft.data.id,
      "minimal fix accept response revision did not become the chapter currentRevision.",
    );
    assert(
      finalChapterRevision.id !== previousChapterRevisionId,
      "chapter currentRevision id did not change after minimal fix accept.",
    );
    assert(
      finalChapterRevision.content === minimalFixGenerate.data.output,
      "accepted minimal fix revision content did not match the generated draft.",
    );
    assert(
      finalChapterRevision.summary === "Smoke minimal fix accept revision",
      "minimal fix accept summary did not persist on the chapter revision.",
    );
    assert(
      finalChapterRevisions.length >= previousChapterRevisionCount + 1,
      "chapter revision list did not grow after minimal fix accept.",
    );
    assert(
      acceptMinimalFixDraft.data.sourceDraftId === minimalFixGenerate.data.draftId,
      "minimal fix accept sourceDraftId mismatch.",
    );
    assert(
      acceptMinimalFixDraft.data.sourceRunId === minimalFixGenerate.data.runId,
      "minimal fix accept sourceRunId mismatch.",
    );

    const progressAfterMinimalFixAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${progressArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(progressAfterMinimalFixAccept, "progress after minimal fix accept");
    assert(
      progressAfterMinimalFixAccept.data.currentRevision?.content?.includes("## 接受日志"),
      "progress artifact did not keep the accept log block.",
    );
    assert(
      progressAfterMinimalFixAccept.data.currentRevision?.content?.includes(
        `${findingsArtifact.filename} <- review_content: Smoke review accept revision`,
      ),
      "progress artifact did not record the accepted review draft.",
    );
    assert(
      progressAfterMinimalFixAccept.data.currentRevision?.content?.includes(
        `${secondChapterFilename} <- minimal_fix: Smoke minimal fix accept revision`,
      ),
      "progress artifact did not record the accepted minimal fix draft.",
    );

    const currentStateAfterMinimalFixAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${currentStateArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(currentStateAfterMinimalFixAccept, "current state after minimal fix accept");
    assert(
      currentStateAfterMinimalFixAccept.data.currentRevision?.content?.includes("## 自动同步记录"),
      "current state artifact did not keep the auto sync block.",
    );
    assert(
      currentStateAfterMinimalFixAccept.data.currentRevision?.content?.includes(`最近回填文件：${secondChapterFilename}`),
      "current state artifact did not point at the final accepted chapter file.",
    );
    assert(
      currentStateAfterMinimalFixAccept.data.currentRevision?.content?.includes("来源任务：minimal_fix"),
      "current state artifact did not record the minimal_fix task type.",
    );
    assert(
      currentStateAfterMinimalFixAccept.data.currentRevision?.content?.includes("回填摘要：Smoke minimal fix accept revision"),
      "current state artifact did not record the final accept summary.",
    );

    const projectAfterMinimalFixAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(projectAfterMinimalFixAccept, "project after minimal fix accept");
    const nextProjectUpdatedAt = Date.parse(projectAfterMinimalFixAccept.data.updatedAt);
    assert(nextProjectUpdatedAt >= previousProjectUpdatedAt, "project updatedAt did not move forward after minimal fix accept.");
    assert(
      projectAfterMinimalFixAccept.data.preference?.activeChapterArtifactId === secondChapterArtifactId,
      "project preference lost the active chapter after the end-to-end flow.",
    );

    const finalChapterIndex = Array.isArray(projectAfterMinimalFixAccept.data.preference?.chapterIndex)
      ? projectAfterMinimalFixAccept.data.preference.chapterIndex
      : [];
    const finalChapterEntry = finalChapterIndex.find((item) => item.artifactId === secondChapterArtifactId);
    assert(finalChapterEntry, "chapterIndex entry for the active chapter was not found.");
    assert(finalChapterEntry.status === "accepted", "chapterIndex entry did not end in accepted status.");
    assert(
      finalChapterEntry.latestDraftId === minimalFixGenerate.data.draftId,
      "chapterIndex latestDraftId did not track the minimal fix draft.",
    );
    assert(finalChapterEntry.wordCount > 0, "chapterIndex wordCount was not updated.");

    const runsAfterFlow = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/runs`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(runsAfterFlow, "runs after full flow");
    const chapterRejectRun = findItemById(runsAfterFlow.data.items, chapterGenerateReject.data.runId, "chapter reject run");
    const chapterAcceptRun = findItemById(runsAfterFlow.data.items, chapterGenerateAccept.data.runId, "chapter accept run");
    const reviewRejectRun = findItemById(runsAfterFlow.data.items, reviewGenerateReject.data.runId, "review reject run");
    const reviewAcceptRun = findItemById(runsAfterFlow.data.items, reviewGenerateAccept.data.runId, "review accept run");
    const minimalFixRun = findItemById(runsAfterFlow.data.items, minimalFixGenerate.data.runId, "minimal fix run");

    for (const run of [chapterRejectRun, chapterAcceptRun, reviewRejectRun, reviewAcceptRun, minimalFixRun]) {
      assert(run.status === "succeeded", `expected run ${run.id} to succeed, got ${run.status}`);
    }
    assert(
      typeof chapterRejectRun.resolvedPrompt === "string" && !chapterRejectRun.resolvedPrompt.includes(chapterGuidanceLabel),
      "direct chapter run resolvedPrompt unexpectedly contained the guidance brief.",
    );
    assert(
      typeof chapterAcceptRun.resolvedPrompt === "string" &&
        chapterAcceptRun.resolvedPrompt.includes(chapterGuidanceLabel) &&
        chapterAcceptRun.resolvedPrompt.includes(chapterGuidanceAnswer) &&
        chapterAcceptRun.resolvedPrompt.includes(chapterGuidanceEphemeralLine),
      "guided chapter run resolvedPrompt did not keep the guidance brief.",
    );

    for (const run of [chapterRejectRun, chapterAcceptRun, reviewRejectRun, reviewAcceptRun]) {
      const toolInventory = Array.isArray(run.toolCallsSummary?.toolInventory) ? run.toolCallsSummary.toolInventory : [];
      const toolCalls = Array.isArray(run.toolCallsSummary?.calls) ? run.toolCallsSummary.calls : [];

      assert(toolInventory.length > 0, `run ${run.id} did not persist MCP tool inventory.`);
      assert(toolCalls.length > 0, `run ${run.id} did not persist MCP tool calls.`);
      assert(
        toolInventory.some(
          (item) =>
            item.serverId === mcpId &&
            typeof item.namespacedToolName === "string" &&
            item.namespacedToolName.endsWith("__lookup_fact"),
        ),
        `run ${run.id} did not record the namespaced MCP tool.`,
      );
      assert(
        toolCalls.some(
          (item) => typeof item.toolName === "string" && item.toolName.endsWith("__lookup_fact") && item.output,
        ),
        `run ${run.id} did not record the MCP tool output.`,
      );
    }

    const draftsAfterFlow = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(draftsAfterFlow, "drafts after full flow");

    const chapterRejectedDraft = findItemById(
      draftsAfterFlow.data.items,
      chapterGenerateReject.data.draftId,
      "chapter rejected draft",
    );
    const chapterAcceptedDraft = findItemById(
      draftsAfterFlow.data.items,
      chapterGenerateAccept.data.draftId,
      "chapter accepted draft",
    );
    const reviewRejectedDraft = findItemById(
      draftsAfterFlow.data.items,
      reviewGenerateReject.data.draftId,
      "review rejected draft",
    );
    const reviewAcceptedDraft = findItemById(
      draftsAfterFlow.data.items,
      reviewGenerateAccept.data.draftId,
      "review accepted draft",
    );
    const minimalFixAcceptedDraft = findItemById(
      draftsAfterFlow.data.items,
      minimalFixGenerate.data.draftId,
      "minimal fix accepted draft",
    );
    const finalAutosaveDraft = findItemById(draftsAfterFlow.data.items, autosaveSeed.data.id, "final autosave draft");

    assert(chapterRejectedDraft.status === "rejected", "chapter reject draft did not stay rejected.");
    assert(chapterAcceptedDraft.status === "accepted", "chapter accepted draft did not stay accepted.");
    assert(reviewRejectedDraft.status === "rejected", "review reject draft did not stay rejected.");
    assert(reviewAcceptedDraft.status === "accepted", "review accepted draft did not stay accepted.");
    assert(reviewAcceptedDraft.draftKind === "review_revision", "review accept draftKind was not review_revision.");
    assert(minimalFixAcceptedDraft.status === "accepted", "minimal fix accepted draft did not stay accepted.");
    assert(finalAutosaveDraft.outputContent.includes(autosaveReviewMarker), "autosave draft did not keep the latest chapter text.");

    assert(providerState.requestBodies.length >= 8, `expected at least 8 provider requests, got ${providerState.requestBodies.length}`);
    assert(mcpState.requestCount >= 4, `expected MCP server to receive at least 4 requests, got ${mcpState.requestCount}`);

    console.log(
      JSON.stringify({
        baseUrl,
        providerBaseUrl,
        mcpServerUrl,
        projectId,
        endpointId,
        mcpId,
        referenceId: referenceItem.id,
        chapterArtifactId: secondChapterArtifactId,
        findingsArtifactId: findingsArtifact.id,
        chapterGuidanceAnswer,
        chapterRejectRunId: chapterGenerateReject.data.runId,
        chapterAcceptRunId: chapterGenerateAccept.data.runId,
        reviewRejectRunId: reviewGenerateReject.data.runId,
        reviewAcceptRunId: reviewGenerateAccept.data.runId,
        minimalFixRunId: minimalFixGenerate.data.runId,
        chapterRejectDraftId: chapterGenerateReject.data.draftId,
        chapterAcceptDraftId: chapterGenerateAccept.data.draftId,
        reviewRejectDraftId: reviewGenerateReject.data.draftId,
        reviewAcceptDraftId: reviewGenerateAccept.data.draftId,
        minimalFixDraftId: minimalFixGenerate.data.draftId,
        finalChapterRevisionId: acceptMinimalFixDraft.data.id,
        providerRequestCount: providerState.requestBodies.length,
        mcpRequestCount: mcpState.requestCount,
        finalChapterStatus: finalChapterEntry.status,
        syncedArtifactCount: acceptMinimalFixDraft.data.syncedArtifacts.length,
      }),
    );
  } finally {
    child.kill("SIGTERM");
    await sleep(1000);

    if (!child.killed) {
      child.kill("SIGKILL");
    }

    await Promise.allSettled([closeServer(providerServer), closeServer(mcpServer)]);

    if (stderr.trim()) {
      process.stderr.write(stderr);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
