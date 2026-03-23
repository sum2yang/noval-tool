import http from "node:http";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import process from "node:process";

const nextPort = Number(process.env.NEXT_SMOKE_PORT || 3111);
const providerPort = Number(process.env.MOCK_PROVIDER_PORT || 3121);
const grokPort = Number(process.env.MOCK_GROK_PORT || 3131);
const loopbackAlias = process.env.SMOKE_LOOPBACK_HOST || "localhost.localstack.cloud";

const baseUrl = `http://localhost:${nextPort}`;
const providerBaseUrl = `http://${loopbackAlias}:${providerPort}/v1`;
const grokBaseUrl = `http://${loopbackAlias}:${grokPort}`;
const nextBin = "node_modules/next/dist/bin/next";
const referenceMarker = "九州城依河设港，秋季船期更密，夜间货栈会按照潮汐钟点安排装卸与清点税票。";
const researchFactMarker = "秋季船期更密，税票改革后夜航窗口更集中。";
const researchUserInstruction = "请核查晚清港口秋季船期与税票改革对夜航仓位分配的影响。";
const chapterUserInstruction = "请基于已核查事实续写当前章节，重点写夜班仓位谈判。";

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
      taskKind: "research_fact_check",
      index: findFirstMarkerIndex(haystack, [
        "research_fact_check",
        "考据与事实核查",
        "事实结论 + 来源",
        researchUserInstruction,
      ]),
    },
    {
      taskKind: "generate_chapter",
      index: findFirstMarkerIndex(haystack, [
        "generate_chapter",
        "写作自检 + 正文",
        "续写当前章节",
        chapterUserInstruction,
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
        "## 冲突点",
        "- 港口年鉴更强调到港量增幅，税务公报更强调清点顺序调整；两者对事实方向一致，但口径侧重点不同。",
        "",
        "## 可写入项目的事实补充",
        `- findings.md：${researchFactMarker}`,
      ].join("\n");
    case "generate_chapter":
      return [
        "【写作自检】",
        `- 事实锚点：${researchFactMarker}`,
        "- 连续性：主角依据 findings 中的夜航窗口信息推进谈判。",
        "",
        "正文",
        "周敬安没有急着压价，先对着夜潮钟和税票底册核了一遍，确认今夜真会把卸货窗口集中到后半夜。",
        "等对方露出想抢夜班仓位的神色后，他才顺势开口谈让渡比例，把原本虚浮的筹码压成了可以落袋的条件。",
        "",
        "【建议回填】",
        "- progress.md",
        "- 99_当前状态卡.md",
      ].join("\n");
    default:
      return "Smoke health response.";
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
      input_tokens: 52,
      output_tokens: 44,
      total_tokens: 96,
    },
  };
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
      prompt_tokens: 52,
      completion_tokens: 44,
      total_tokens: 96,
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
      headers: {
        authorization: request.headers.authorization ?? null,
      },
      body,
    });
    const requestIndex = state.requests.length;

    if (url.pathname === "/v1/responses") {
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
      headers: {
        authorization: request.headers.authorization ?? null,
      },
      body,
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
  const match = items.find(predicate);
  assert(match, `${label} was not found.`);
  return match;
}

function findItemById(items, id, label) {
  const match = items.find((item) => item.id === id);
  assert(match, `${label} was not found.`);
  return match;
}

function assertResolvedArtifactKeys(run, expectedKeys, label) {
  const resolvedArtifacts = Array.isArray(run.resolvedContextArtifacts) ? run.resolvedContextArtifacts : [];
  const resolvedKeys = new Set(
    resolvedArtifacts
      .filter((item) => item && typeof item.artifactKey === "string")
      .map((item) => item.artifactKey),
  );

  for (const key of expectedKeys) {
    assert(resolvedKeys.has(key), `${label} did not include resolved artifact key ${key}.`);
  }
}

function assertAcceptedRevision({
  acceptResponse,
  artifactAfterAccept,
  generatedOutput,
  expectedSummary,
  previousRevisionId,
  previousRevisionCount,
  expectedDraftId,
  expectedRunId,
  label,
}) {
  const currentRevision = artifactAfterAccept.data.currentRevision;
  const revisions = Array.isArray(artifactAfterAccept.data.revisions) ? artifactAfterAccept.data.revisions : [];

  assert(currentRevision, `${label} currentRevision was not updated.`);
  assert(currentRevision.id === acceptResponse.data.id, `${label} accept response revision id did not become currentRevision.`);
  assert(currentRevision.id !== previousRevisionId, `${label} currentRevision id did not change after accept.`);
  assert(currentRevision.content === generatedOutput, `${label} accepted revision content did not match draft output.`);
  assert(currentRevision.summary === expectedSummary, `${label} revision summary did not persist.`);
  assert(revisions.length >= previousRevisionCount + 1, `${label} revision list did not grow after accept.`);
  assert(acceptResponse.data.sourceDraftId === expectedDraftId, `${label} sourceDraftId mismatch.`);
  assert(acceptResponse.data.sourceRunId === expectedRunId, `${label} sourceRunId mismatch.`);
  assert(Array.isArray(acceptResponse.data.syncedArtifacts), `${label} accept response did not include syncedArtifacts.`);
  assert(acceptResponse.data.syncedArtifacts.length === 2, `${label} accept should have synced 2 state artifacts.`);
}

async function main() {
  await ensureProductionBuild();

  const providerState = {
    requests: [],
  };
  const grokState = {
    requests: [],
  };

  const providerServer = createMockProviderServer(providerState);
  const grokServer = createMockGrokServer(grokState);

  await Promise.all([listen(providerServer, providerPort), listen(grokServer, grokPort)]);

  const child = spawn(process.execPath, [nextBin, "start", "-p", String(nextPort)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      APP_BASE_URL: baseUrl,
      BETTER_AUTH_URL: baseUrl,
      GROK_API_URL: grokBaseUrl,
      GROK_API_KEY: "smoke-grok-key",
      GROK_MODEL: "smoke-grok-model",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer();

    const email = `smoke-research-e2e-${Date.now()}@example.com`;
    const signup = await fetchJson(`${baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Smoke Research E2E Tester",
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
          name: "Smoke Research Project",
          genre: "历史",
          platform: "起点",
          status: "active",
        }),
      },
      cookies,
    );
    assertOk(project, "project creation");

    const projectId = project.data.project.id;

    const referenceForm = new FormData();
    referenceForm.set(
      "file",
      new File(
        [
          `# 港口考据笔记\n\n${referenceMarker}\n夜班仓位会被优先分配给已经完成税票核验的船只。`,
        ],
        "harbor-notes.md",
        { type: "text/markdown" },
      ),
    );
    referenceForm.set("tags", "港口, 考据");
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

    const artifactsInitial = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(artifactsInitial, "initial artifacts");

    const findingsArtifact = findArtifactBy(
      artifactsInitial.data.items,
      (item) => item.artifactKey === "findings",
      "findings artifact",
    );
    const progressArtifact = findArtifactBy(
      artifactsInitial.data.items,
      (item) => item.artifactKey === "progress",
      "progress artifact",
    );
    const currentStateArtifact = findArtifactBy(
      artifactsInitial.data.items,
      (item) => item.artifactKey === "current_state_card",
      "current state artifact",
    );
    const chapterArtifact = findArtifactBy(
      artifactsInitial.data.items,
      (item) => item.kind === "project_chapter",
      "initial chapter artifact",
    );

    const endpoint = await fetchJson(
      `${baseUrl}/api/provider-endpoints`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerType: "openai",
          label: "Mock OpenAI Research Smoke",
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

    const findingsBeforeAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${findingsArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(findingsBeforeAccept, "findings before accept");

    const progressBeforeAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${progressArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(progressBeforeAccept, "progress before accept");

    const currentStateBeforeAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${currentStateArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(currentStateBeforeAccept, "current state before accept");

    const projectBeforeAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(projectBeforeAccept, "project before accept");
    const previousProjectUpdatedAt = Date.parse(projectBeforeAccept.data.updatedAt);

    const providerRequestStart = providerState.requests.length;
    const grokRequestStart = grokState.requests.length;
    const researchGenerate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskType: "research_fact_check",
          userInstruction: researchUserInstruction,
          endpointId,
          modelId: "gpt-4o-mini",
          selectedArtifactIds: [],
          selectedReferenceIds: [referenceItem.id],
          selectedMcpServerIds: [],
          generationOptions: {
            temperature: 0,
            maxTokens: 1200,
          },
        }),
      },
      cookies,
    );
    assertOk(researchGenerate, "research_fact_check generate");
    assert(
      typeof researchGenerate.data.output === "string" &&
        researchGenerate.data.output.includes("## 结论") &&
        researchGenerate.data.output.includes("## 来源摘要") &&
        researchGenerate.data.output.includes("## 冲突点") &&
        researchGenerate.data.output.includes("## 可写入项目的事实补充"),
      "research_fact_check output did not match the expected contract.",
    );
    assert(
      Array.isArray(researchGenerate.data.suggestedPatches) &&
        researchGenerate.data.suggestedPatches.includes("findings.md"),
      "research_fact_check did not suggest findings.md as the accept target.",
    );

    const providerRequestsForResearch = providerState.requests.slice(providerRequestStart);
    const providerRequestText = providerRequestsForResearch.map((request) => extractBodyText(request.body)).join("\n");
    assert(
      providerRequestText.includes("以下内容来自 GrokSearch"),
      "research_fact_check prompt did not include the GrokSearch external facts section.",
    );
    assert(
      providerRequestText.includes("Harbor Report") &&
        providerRequestText.includes("https://example.com/customs-bulletin"),
      "research_fact_check prompt did not include the resolved GrokSearch source summaries.",
    );
    assert(
      providerRequestText.includes(referenceMarker),
      "research_fact_check prompt did not include the selected reference content.",
    );

    const grokRequestsForResearch = grokState.requests.slice(grokRequestStart);
    assert(grokRequestsForResearch.length === 1, `expected 1 GrokSearch request, got ${grokRequestsForResearch.length}`);
    assert(
      grokRequestsForResearch[0].headers.authorization === "Bearer smoke-grok-key",
      "research_fact_check Grok request did not include the configured bearer token.",
    );
    assert(
      grokRequestsForResearch[0].body?.payload?.query === researchUserInstruction,
      "research_fact_check did not forward userInstruction to GrokSearch.",
    );
    assert(
      grokRequestsForResearch[0].body?.payload?.taskType === "research_fact_check",
      "research_fact_check did not forward taskType to GrokSearch.",
    );
    assert(
      extractBodyText(grokRequestsForResearch[0].body?.payload?.selectedReferences).includes(referenceMarker),
      "research_fact_check did not forward selected reference context to GrokSearch.",
    );

    const runsAfterResearchGenerate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/runs`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(runsAfterResearchGenerate, "runs after research generate");

    const draftsAfterResearchGenerate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(draftsAfterResearchGenerate, "drafts after research generate");

    const researchRun = findItemById(
      runsAfterResearchGenerate.data.items,
      researchGenerate.data.runId,
      "research_fact_check run",
    );
    const researchDraft = findItemById(
      draftsAfterResearchGenerate.data.items,
      researchGenerate.data.draftId,
      "research_fact_check draft",
    );

    assert(researchRun.status === "succeeded", `research_fact_check run status was ${researchRun.status}`);
    assert(researchDraft.status === "ready", `research_fact_check draft status was ${researchDraft.status}`);
    assert(
      Array.isArray(researchRun.selectedReferenceIds) &&
        researchRun.selectedReferenceIds.includes(referenceItem.id),
      "research_fact_check run did not persist the selected reference id.",
    );
    assertResolvedArtifactKeys(
      researchRun,
      ["writing_rules", "current_state_card"],
      "research_fact_check run",
    );

    const externalSearch = researchRun.toolCallsSummary?.externalSearch;
    assert(externalSearch, "research_fact_check run did not persist externalSearch summary.");
    assert(externalSearch.provider === "groksearch", `unexpected external search provider ${externalSearch.provider}`);
    assert(externalSearch.toolName === "web_search", `unexpected external search tool ${externalSearch.toolName}`);
    assert(externalSearch.status === "ok", `unexpected external search status ${externalSearch.status}`);
    assert(externalSearch.attemptCount === 1, `unexpected external search attempt count ${externalSearch.attemptCount}`);
    assert(
      externalSearch.payload?.taskType === "research_fact_check",
      "externalSearch payload did not record research_fact_check as the task type.",
    );
    assert(
      typeof externalSearch.dataPreview === "string" && externalSearch.dataPreview.includes("Harbor Report"),
      "externalSearch dataPreview did not include the GrokSearch result preview.",
    );

    const researchAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts/${researchDraft.id}/accept`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          artifactId: findingsArtifact.id,
          summary: "Smoke research accept revision",
        }),
      },
      cookies,
    );
    assertOk(researchAccept, "research_fact_check accept");

    const draftsAfterAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(draftsAfterAccept, "drafts after research accept");
    const acceptedResearchDraft = findItemById(
      draftsAfterAccept.data.items,
      researchDraft.id,
      "accepted research draft",
    );
    assert(acceptedResearchDraft.status === "accepted", `accepted research draft status was ${acceptedResearchDraft.status}`);

    const findingsAfterAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${findingsArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(findingsAfterAccept, "findings after accept");
    assertAcceptedRevision({
      acceptResponse: researchAccept,
      artifactAfterAccept: findingsAfterAccept,
      generatedOutput: researchGenerate.data.output,
      expectedSummary: "Smoke research accept revision",
      previousRevisionId: findingsBeforeAccept.data.currentRevision?.id ?? null,
      previousRevisionCount: Array.isArray(findingsBeforeAccept.data.revisions)
        ? findingsBeforeAccept.data.revisions.length
        : 0,
      expectedDraftId: researchDraft.id,
      expectedRunId: researchRun.id,
      label: "research_fact_check accept",
    });

    const progressAfterAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${progressArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(progressAfterAccept, "progress after accept");
    assert(
      progressAfterAccept.data.currentRevision?.id !== progressBeforeAccept.data.currentRevision?.id,
      "progress currentRevision id did not change after research_fact_check accept.",
    );
    assert(
      progressAfterAccept.data.currentRevision?.content?.includes(
        "findings.md <- research_fact_check: Smoke research accept revision",
      ),
      "progress accept log did not record the research_fact_check acceptance.",
    );

    const currentStateAfterAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${currentStateArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(currentStateAfterAccept, "current state after accept");
    assert(
      currentStateAfterAccept.data.currentRevision?.id !== currentStateBeforeAccept.data.currentRevision?.id,
      "current state currentRevision id did not change after research_fact_check accept.",
    );
    assert(
      currentStateAfterAccept.data.currentRevision?.content?.includes("最近回填文件：findings.md"),
      "current state artifact did not record findings.md as the latest accepted artifact.",
    );
    assert(
      currentStateAfterAccept.data.currentRevision?.content?.includes("来源任务：research_fact_check"),
      "current state artifact did not record research_fact_check as the latest task type.",
    );

    const projectAfterAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(projectAfterAccept, "project after accept");
    const nextProjectUpdatedAt = Date.parse(projectAfterAccept.data.updatedAt);
    assert(nextProjectUpdatedAt >= previousProjectUpdatedAt, "project updatedAt did not move forward after accept.");

    const providerRequestStartBeforeChapter = providerState.requests.length;
    const grokRequestCountBeforeChapter = grokState.requests.length;
    const chapterGenerate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskType: "generate_chapter",
          userInstruction: chapterUserInstruction,
          endpointId,
          modelId: "gpt-4o-mini",
          targetArtifactId: chapterArtifact.id,
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
    assertOk(chapterGenerate, "generate_chapter after research accept");
    assert(
      typeof chapterGenerate.data.output === "string" &&
        chapterGenerate.data.output.includes("【写作自检】") &&
        chapterGenerate.data.output.includes("正文"),
      "generate_chapter output did not match the expected contract after research accept.",
    );

    const chapterProviderRequests = providerState.requests.slice(providerRequestStartBeforeChapter);
    const chapterProviderText = chapterProviderRequests.map((request) => extractBodyText(request.body)).join("\n");
    assert(
      chapterProviderText.includes(researchFactMarker),
      "generate_chapter prompt did not read the accepted research_fact_check findings content.",
    );
    assert(
      chapterProviderText.includes("findings.md"),
      "generate_chapter prompt did not include findings.md after research acceptance.",
    );
    assert(
      grokState.requests.length === grokRequestCountBeforeChapter,
      "generate_chapter unexpectedly triggered a new GrokSearch request instead of reading accepted findings.",
    );

    const runsAfterChapterGenerate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/runs`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(runsAfterChapterGenerate, "runs after chapter generate");
    const chapterRun = findItemById(
      runsAfterChapterGenerate.data.items,
      chapterGenerate.data.runId,
      "generate_chapter run after research accept",
    );
    assert(chapterRun.status === "succeeded", `generate_chapter run status was ${chapterRun.status}`);
    assertResolvedArtifactKeys(
      chapterRun,
      ["writing_rules", "task_plan", "findings", "progress", "current_state_card"],
      "generate_chapter run after research accept",
    );

    console.log(
      JSON.stringify({
        baseUrl,
        providerBaseUrl,
        grokBaseUrl,
        projectId,
        endpointId,
        referenceId: referenceItem.id,
        researchRunId: researchRun.id,
        researchDraftId: researchDraft.id,
        chapterRunId: chapterGenerate.data.runId,
        findingsArtifactId: findingsArtifact.id,
        chapterArtifactId: chapterArtifact.id,
        providerRequestCount: providerState.requests.length,
        grokRequestCount: grokState.requests.length,
      }),
    );
  } finally {
    child.kill("SIGTERM");
    await sleep(1000);

    if (!child.killed) {
      child.kill("SIGKILL");
    }

    await Promise.allSettled([closeServer(providerServer), closeServer(grokServer)]);

    if (stderr.trim()) {
      process.stderr.write(stderr);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
