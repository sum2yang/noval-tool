import http from "node:http";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import process from "node:process";

const nextPort = Number(process.env.NEXT_SMOKE_PORT || 3110);
const providerPort = Number(process.env.MOCK_PROVIDER_PORT || 3120);
const loopbackAlias = process.env.SMOKE_LOOPBACK_HOST || "localhost.localstack.cloud";

const baseUrl = `http://localhost:${nextPort}`;
const providerBaseUrl = `http://${loopbackAlias}:${providerPort}/v1`;
const nextBin = "node_modules/next/dist/bin/next";
const markdownMarker = "九州城依河设港，夜间货栈以潮汐钟点安排装卸。";
const htmlMarker = "首帖摘要：第七码头在秋季会优先让渡夜班仓位。";
const htmlOneboxMarker = "Onebox 摘要：船只要先验税票，再按潮位入港。";
const findingsMarker = "建议写入的项目文件";
const scriptNoiseMarker = "不要进入提炼正文";

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
      taskKind: "ingest_sources",
      index: findFirstMarkerIndex(haystack, [
        "ingest_sources",
        "资料吸收与规则提炼",
        "提炼规则清单",
        "建议写入的项目文件",
      ]),
    },
  ]
    .filter((item) => Number.isFinite(item.index))
    .sort((left, right) => left.index - right.index);

  return matches[0]?.taskKind ?? null;
}

function buildTaskOutput(taskKind, body) {
  if (extractBodyText(body).includes("Reply with exactly OK")) {
    return "OK";
  }

  switch (taskKind) {
    case "ingest_sources":
      return [
        "# 资料吸收结果",
        "",
        "## 提炼规则清单",
        `1. ${markdownMarker}`,
        `2. ${htmlMarker}`,
        `3. ${htmlOneboxMarker}`,
        "",
        "## 规则分组",
        "- 港务流程：夜间装卸受潮汐钟点和税票校验约束。",
        "- 仓位规则：秋季第七码头会优先让渡夜班仓位。",
        "",
        "## 冲突与覆盖说明",
        "- 当前两份资料互补，没有发现直接冲突；论坛 HTML 补足了仓位让渡细节。",
        "",
        "## 建议写入的项目文件",
        "- findings.md",
        "",
        "## 资料依据",
        "- harbor-rules.md: 港口基础规则与税票核对顺序。",
        "- harbor-thread.html: 首帖摘要与 onebox 调度补充。",
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
      output_tokens: 58,
      total_tokens: 110,
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
      completion_tokens: 58,
      total_tokens: 110,
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

    const email = `smoke-ingest-e2e-${Date.now()}@example.com`;
    const signup = await fetchJson(`${baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Smoke Ingest Tester",
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
          name: "Smoke Ingest Project",
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

    const markdownForm = new FormData();
    markdownForm.set(
      "file",
      new File(
        [
          [
            "# 港口规则",
            "",
            markdownMarker,
            "值夜掌柜会先核对税票，再决定是否放行货船。",
          ].join("\n"),
        ],
        "harbor-rules.md",
        { type: "text/markdown" },
      ),
    );
    markdownForm.set("tags", "港口, 规则");
    markdownForm.set("sourceUrl", "https://example.com/harbor-rules");

    const markdownReference = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/references`,
      {
        method: "POST",
        body: markdownForm,
      },
      cookies,
    );
    assertOk(markdownReference, "markdown reference upload");
    const markdownReferenceItem = markdownReference.data.items?.[0];
    assert(markdownReferenceItem, "markdown reference upload did not return an item.");
    assert(
      markdownReferenceItem.sourceType === "markdown",
      `expected markdown sourceType, got ${markdownReferenceItem.sourceType}`,
    );
    assert(
      markdownReferenceItem.extractionMethod === "markdown:utf8",
      `expected markdown extraction method, got ${markdownReferenceItem.extractionMethod}`,
    );
    assert(markdownReferenceItem.storageKey, "markdown reference did not persist storageKey.");

    const htmlForm = new FormData();
    htmlForm.set(
      "file",
      new File(
        [
          [
            "<!doctype html>",
            "<html><head><title>港口讨论串</title><style>.shell{display:none}</style><script>window.__shellNoise='不要进入提炼正文';</script></head>",
            "<body><header>论坛导航</header><article>",
            "<h1>港口讨论串</h1>",
            `<p>${htmlMarker}</p>`,
            '<div class="onebox"><a href="https://example.com/night-dispatch">Onebox 标题：夜航调度备忘</a>',
            `<p>${htmlOneboxMarker}</p></div>`,
            "</article><footer>论坛页脚</footer></body></html>",
          ].join(""),
        ],
        "harbor-thread.html",
        { type: "text/html" },
      ),
    );
    htmlForm.set("tags", "论坛, HTML");
    htmlForm.set("sourceUrl", "https://example.com/harbor-thread");

    const htmlReference = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/references`,
      {
        method: "POST",
        body: htmlForm,
      },
      cookies,
    );
    assertOk(htmlReference, "html reference upload");
    const htmlReferenceItem = htmlReference.data.items?.[0];
    assert(htmlReferenceItem, "html reference upload did not return an item.");
    assert(
      htmlReferenceItem.sourceType === "html_static_topic",
      `expected html_static_topic sourceType, got ${htmlReferenceItem.sourceType}`,
    );
    assert(
      htmlReferenceItem.extractionMethod === "html:readable_text",
      `expected html extraction method, got ${htmlReferenceItem.extractionMethod}`,
    );
    assert(
      typeof htmlReferenceItem.normalizedText === "string" &&
        htmlReferenceItem.normalizedText.includes(htmlMarker) &&
        htmlReferenceItem.normalizedText.includes(htmlOneboxMarker),
      "html reference normalizedText did not keep the visible article content.",
    );
    assert(
      !htmlReferenceItem.normalizedText.includes(scriptNoiseMarker),
      "html reference normalizedText still contained stripped script noise.",
    );

    const references = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/references`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(references, "references listing");

    const listedMarkdownReferenceItem = findItemById(
      references.data.items,
      markdownReferenceItem.id,
      "markdown reference item",
    );
    const listedHtmlReferenceItem = findItemById(references.data.items, htmlReferenceItem.id, "html reference item");

    assert(
      listedMarkdownReferenceItem.normalizedText?.includes(markdownMarker),
      "markdown reference normalizedText was missing the markdown marker.",
    );
    assert(
      listedHtmlReferenceItem.normalizedText?.includes(htmlMarker) &&
        listedHtmlReferenceItem.normalizedText?.includes(htmlOneboxMarker),
      "html reference listing did not keep the extracted readable text.",
    );

    const endpoint = await fetchJson(
      `${baseUrl}/api/provider-endpoints`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerType: "openai",
          label: "Mock OpenAI Ingest Smoke",
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

    const providerRequestStart = providerState.requestBodies.length;
    const generate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskType: "ingest_sources",
          userInstruction: "请提炼这两份资料里的港务规则、流程约束、冲突说明和建议回填文件。",
          endpointId,
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
    assertOk(generate, "ingest_sources generate");
    assert(
      typeof generate.data.output === "string" &&
        generate.data.output.includes("## 提炼规则清单") &&
        generate.data.output.includes(findingsMarker),
      "ingest_sources output did not match the expected contract.",
    );
    assert(
      Array.isArray(generate.data.suggestedPatches) && generate.data.suggestedPatches.includes("findings.md"),
      "ingest_sources did not suggest findings.md as the accept target.",
    );

    const providerRequestBodies = providerState.requestBodies.slice(providerRequestStart);
    const providerRequestText = providerRequestBodies.map((body) => extractBodyText(body)).join("\n");
    assert(
      providerRequestText.includes(markdownMarker),
      "provider request did not include the uploaded markdown reference content.",
    );
    assert(
      providerRequestText.includes(htmlMarker) && providerRequestText.includes(htmlOneboxMarker),
      "provider request did not include the extracted HTML readable text.",
    );
    assert(
      !providerRequestText.includes(scriptNoiseMarker),
      "provider request still contained stripped HTML shell/script noise.",
    );

    const runs = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/runs`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(runs, "runs listing");

    const drafts = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(drafts, "drafts listing");

    const run = findItemById(runs.data.items, generate.data.runId, "ingest_sources run");
    const draft = findItemById(drafts.data.items, generate.data.draftId, "ingest_sources draft");

    assert(run.status === "succeeded", `ingest_sources run status was ${run.status}`);
    assert(draft.status === "ready", `ingest_sources draft status was ${draft.status}`);
    assert(Array.isArray(run.selectedReferenceIds), "ingest_sources run selectedReferenceIds was not persisted.");
    assert(run.selectedReferenceIds.includes(markdownReferenceItem.id), "run did not record markdown reference id.");
    assert(run.selectedReferenceIds.includes(htmlReferenceItem.id), "run did not record html reference id.");
    assert(
      Array.isArray(run.selectedArtifactIds) && run.selectedArtifactIds.length === 0,
      "ingest_sources run should not auto-resolve project artifacts when none were selected.",
    );
    assert(
      Array.isArray(run.resolvedContextArtifacts) && run.resolvedContextArtifacts.length === 0,
      "ingest_sources run should keep resolvedContextArtifacts empty when only references are selected.",
    );

    const accept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts/${draft.id}/accept`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          artifactId: findingsArtifact.id,
          summary: "Smoke ingest accept revision",
        }),
      },
      cookies,
    );
    assertOk(accept, "ingest_sources accept");

    const draftsAfterAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(draftsAfterAccept, "drafts after accept");
    const draftAfterAccept = findItemById(draftsAfterAccept.data.items, draft.id, "accepted ingest_sources draft");
    assert(draftAfterAccept.status === "accepted", `accepted draft status was ${draftAfterAccept.status}`);

    const findingsAfterAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${findingsArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(findingsAfterAccept, "findings after accept");
    assertAcceptedRevision({
      acceptResponse: accept,
      artifactAfterAccept: findingsAfterAccept,
      generatedOutput: generate.data.output,
      expectedSummary: "Smoke ingest accept revision",
      previousRevisionId: findingsBeforeAccept.data.currentRevision?.id ?? null,
      previousRevisionCount: Array.isArray(findingsBeforeAccept.data.revisions)
        ? findingsBeforeAccept.data.revisions.length
        : 0,
      expectedDraftId: draft.id,
      expectedRunId: run.id,
      label: "ingest_sources accept",
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
      "progress currentRevision id did not change after ingest_sources accept.",
    );
    assert(
      progressAfterAccept.data.currentRevision?.summary === "Auto sync after accepting findings.md",
      "progress auto-sync summary did not persist after ingest_sources accept.",
    );
    assert(
      progressAfterAccept.data.currentRevision?.content?.includes("findings.md <- ingest_sources: Smoke ingest accept revision"),
      "progress accept log did not record the ingest_sources acceptance.",
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
      "current state currentRevision id did not change after ingest_sources accept.",
    );
    assert(
      currentStateAfterAccept.data.currentRevision?.content?.includes("最近回填文件：findings.md"),
      "current state artifact did not record findings.md as the latest accepted artifact.",
    );
    assert(
      currentStateAfterAccept.data.currentRevision?.content?.includes("来源任务：ingest_sources"),
      "current state artifact did not record ingest_sources as the latest task type.",
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

    assert(
      providerState.requestBodies.length >= 2,
      `expected at least 2 provider requests, got ${providerState.requestBodies.length}`,
    );

    console.log(
      JSON.stringify({
        baseUrl,
        providerBaseUrl,
        projectId,
        endpointId,
        markdownReferenceId: markdownReferenceItem.id,
        htmlReferenceId: htmlReferenceItem.id,
        runId: run.id,
        draftId: draft.id,
        findingsArtifactId: findingsArtifact.id,
        progressArtifactId: progressArtifact.id,
        currentStateArtifactId: currentStateArtifact.id,
        revisionId: accept.data.id,
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
