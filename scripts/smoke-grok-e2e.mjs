import http from "node:http";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import process from "node:process";

const nextPort = Number(process.env.NEXT_SMOKE_PORT || 3109);
const providerPort = Number(process.env.MOCK_PROVIDER_PORT || 3119);
const grokPort = Number(process.env.MOCK_GROK_PORT || 3129);
const loopbackAlias = process.env.SMOKE_LOOPBACK_HOST || "localhost.localstack.cloud";

const baseUrl = `http://localhost:${nextPort}`;
const providerBaseUrl = `http://${loopbackAlias}:${providerPort}/v1`;
const grokBaseUrl = `http://${loopbackAlias}:${grokPort}`;
const nextBin = "node_modules/next/dist/bin/next";

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

function extractBodyText(body) {
  return JSON.stringify(body ?? {});
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

function buildProviderOutput(body) {
  const bodyText = extractBodyText(body);

  if (bodyText.includes("Reply with exactly OK")) {
    return "OK";
  }

  return [
    "问题：港口贸易描写已经有事实锚点，但还缺少把现实事实与剧情边界区分开的提示。",
    "证据：外部事实摘要已确认 Harbor Report 与 Customs Bulletin 共同指向秋季船期和关税调整。",
    "最小修法：在正文或状态卡里补一句“该事实来自公开港口资料，仅作背景补充，不覆盖项目剧情事实”。",
  ].join("\n");
}

function buildResponseApiPayload(body, requestIndex) {
  const model = typeof body?.model === "string" ? body.model : "gpt-4o-mini";

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
            text: buildProviderOutput(body),
            annotations: [],
          },
        ],
      },
    ],
    usage: {
      input_tokens: 48,
      output_tokens: 32,
      total_tokens: 80,
    },
  };
}

function buildChatCompletionPayload(body, requestIndex) {
  const model = typeof body?.model === "string" ? body.model : "gpt-4o-mini";

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
          content: buildProviderOutput(body),
          annotations: [],
        },
      },
    ],
    usage: {
      prompt_tokens: 48,
      completion_tokens: 32,
      total_tokens: 80,
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
        },
      }),
    );
  });
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

    const email = `smoke-grok-e2e-${Date.now()}@example.com`;
    const signup = await fetchJson(`${baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Smoke Grok E2E Tester",
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
          name: "Smoke Grok Project",
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
          "# 港口考据笔记\n\n九州城依河设港，秋季船期更密，夜间货栈会按照潮汐钟点安排装卸与清点税票。",
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

    const endpoint = await fetchJson(
      `${baseUrl}/api/provider-endpoints`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerType: "openai",
          label: "Mock OpenAI Grok Smoke",
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

    const directSearchStart = grokState.requests.length;
    const directGrokSearch = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/search/grok`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          toolName: "web_search",
          payload: {
            query: "晚清港口秋季船期与关税调整",
            locale: "zh-CN",
          },
        }),
      },
      cookies,
    );
    assertOk(directGrokSearch, "direct grok route");
    assert(directGrokSearch.data.status === "ok", `direct grok route returned ${directGrokSearch.data.status}`);
    assert(
      Array.isArray(directGrokSearch.data.data?.sources) && directGrokSearch.data.data.sources.length === 2,
      "direct grok route did not return the expected source summaries.",
    );

    const directSearchRequests = grokState.requests.slice(directSearchStart);
    assert(directSearchRequests.length === 1, `expected 1 direct grok request, got ${directSearchRequests.length}`);
    assert(
      directSearchRequests[0].headers.authorization === "Bearer smoke-grok-key",
      "direct grok request did not include the configured bearer token.",
    );
    assert(
      directSearchRequests[0].body?.model === "smoke-grok-model",
      `direct grok request used unexpected model ${directSearchRequests[0].body?.model}`,
    );
    assert(
      directSearchRequests[0].body?.payload?.query === "晚清港口秋季船期与关税调整",
      "direct grok request did not forward the payload query.",
    );

    const providerRequestStart = providerState.requests.length;
    const generationSearchStart = grokState.requests.length;
    const userInstruction = "请结合外部公开资料审查港口贸易描写是否可信，并按问题、证据、最小修法输出。";
    const generate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskType: "review_content",
          userInstruction,
          endpointId,
          modelId: "gpt-4o-mini",
          selectedArtifactIds: [],
          selectedReferenceIds: [referenceItem.id],
          selectedMcpServerIds: [],
          generationOptions: {
            temperature: 0,
            requireExternalFacts: true,
          },
        }),
      },
      cookies,
    );
    assertOk(generate, "generate with external facts");
    assert(
      typeof generate.data.output === "string" &&
        generate.data.output.includes("问题：") &&
        generate.data.output.includes("最小修法："),
      "generate output did not match the review contract.",
    );

    const generationProviderRequests = providerState.requests.slice(providerRequestStart);
    assert(generationProviderRequests.length >= 1, "generate did not hit the custom provider baseURL.");

    const generationProviderBodyText = generationProviderRequests.map((request) => extractBodyText(request.body)).join("\n");
    assert(
      generationProviderBodyText.includes("以下内容来自 GrokSearch"),
      "generate prompt did not include the GrokSearch external facts section.",
    );
    assert(
      generationProviderBodyText.includes("Harbor Report"),
      "generate prompt did not include the resolved GrokSearch source title.",
    );
    assert(
      generationProviderBodyText.includes("https://example.com/customs-bulletin"),
      "generate prompt did not include the resolved GrokSearch source URL.",
    );
    assert(
      generationProviderBodyText.includes("九州城依河设港"),
      "generate prompt did not include the selected reference content.",
    );
    assert(
      generationProviderRequests.some(
        (request) => request.path === "/v1/responses" || request.path === "/v1/chat/completions",
      ),
      "custom provider request did not hit an OpenAI-compatible path under the custom baseURL.",
    );

    const generationGrokRequests = grokState.requests.slice(generationSearchStart);
    assert(generationGrokRequests.length === 1, `expected 1 generation grok request, got ${generationGrokRequests.length}`);
    assert(
      generationGrokRequests[0].body?.payload?.query === userInstruction,
      "generate did not forward userInstruction to GrokSearch.",
    );
    assert(
      extractBodyText(generationGrokRequests[0].body?.payload?.selectedReferences).includes("九州城依河设港"),
      "generate did not forward selected reference context to GrokSearch.",
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

    const run = runs.data.items.find((item) => item.id === generate.data.runId);
    const draft = drafts.data.items.find((item) => item.id === generate.data.draftId);

    assert(run, "generation run was not persisted.");
    assert(draft, "generation draft was not persisted.");
    assert(run.status === "succeeded", `expected run status succeeded, got ${run.status}`);
    assert(draft.status === "ready", `expected draft status ready, got ${draft.status}`);
    assert(
      Array.isArray(run.selectedReferenceIds) && run.selectedReferenceIds.includes(referenceItem.id),
      "generation run did not persist the selected reference id.",
    );

    const externalSearch = run.toolCallsSummary?.externalSearch;
    assert(externalSearch, "generation run did not persist externalSearch summary.");
    assert(externalSearch.provider === "groksearch", `unexpected external search provider ${externalSearch.provider}`);
    assert(externalSearch.toolName === "web_search", `unexpected external search tool ${externalSearch.toolName}`);
    assert(externalSearch.status === "ok", `unexpected external search status ${externalSearch.status}`);
    assert(externalSearch.attemptCount === 1, `unexpected external search attempt count ${externalSearch.attemptCount}`);
    assert(
      typeof externalSearch.dataPreview === "string" && externalSearch.dataPreview.includes("Harbor Report"),
      "externalSearch dataPreview did not include the GrokSearch result preview.",
    );

    console.log(
      JSON.stringify({
        baseUrl,
        providerBaseUrl,
        grokBaseUrl,
        projectId,
        endpointId,
        referenceId: referenceItem.id,
        runId: generate.data.runId,
        draftId: generate.data.draftId,
        providerHealthStatus: providerHealth.data.status,
        directGrokStatus: directGrokSearch.data.status,
        providerRequestCount: providerState.requests.length,
        grokRequestCount: grokState.requests.length,
        externalSearchStatus: externalSearch.status,
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
