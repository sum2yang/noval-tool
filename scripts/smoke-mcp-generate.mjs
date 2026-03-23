import http from "node:http";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import process from "node:process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const nextPort = Number(process.env.NEXT_SMOKE_PORT || 3107);
const providerPort = Number(process.env.MOCK_PROVIDER_PORT || 3117);
const mcpPort = Number(process.env.MOCK_MCP_PORT || 3127);
const loopbackAlias = process.env.SMOKE_LOOPBACK_HOST || "localhost.localstack.cloud";

const baseUrl = `http://localhost:${nextPort}`;
const providerBaseUrl = `http://${loopbackAlias}:${providerPort}/v1`;
const mcpServerUrl = `http://${loopbackAlias}:${mcpPort}/mcp`;
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

function buildResponseApiPayload(body, requestIndex) {
  const model = typeof body?.model === "string" ? body.model : "gpt-4o-mini";
  const toolResult = Array.isArray(body?.input)
    ? body.input.find((item) => item?.type === "function_call_output")
    : null;
  const toolName = getFirstResponseToolName(body);

  if (toolResult) {
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
              text: [
                "问题：当前段落缺少与外部事实的锚点。",
                `证据：MCP 工具已返回 ${toolResult.output}.`,
                "最小修法：把该事实以一句短设定嵌入正文或状态卡。",
              ].join("\n"),
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

  if (toolName) {
    return {
      id: `resp_${requestIndex}`,
      created_at: Math.floor(Date.now() / 1000),
      model,
      output: [
        {
          type: "function_call",
          id: `fc_${requestIndex}`,
          call_id: `call_${requestIndex}`,
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
            text: "OK",
            annotations: [],
          },
        ],
      },
    ],
    usage: {
      input_tokens: 8,
      output_tokens: 2,
      total_tokens: 10,
    },
  };
}

function buildChatCompletionPayload(body, requestIndex) {
  const model = typeof body?.model === "string" ? body.model : "gpt-4o-mini";
  const hasToolResult = Array.isArray(body?.messages)
    ? body.messages.some((message) => message?.role === "tool")
    : false;
  const toolName = getFirstChatToolName(body);

  if (hasToolResult) {
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
            content: [
              "问题：当前段落缺少与外部事实的锚点。",
              "证据：MCP 工具已返回补充事实。",
              "最小修法：把该事实以一句短设定嵌入正文或状态卡。",
            ].join("\n"),
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
                id: `call_${requestIndex}`,
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
          content: "OK",
          annotations: [],
        },
      },
    ],
    usage: {
      prompt_tokens: 8,
      completion_tokens: 2,
      total_tokens: 10,
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

async function main() {
  await ensureProductionBuild();

  const providerState = {
    requestBodies: [],
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

    const email = `smoke-mcp-generate-${Date.now()}@example.com`;
    const signup = await fetchJson(`${baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Smoke MCP Generate Tester",
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
          name: "Smoke MCP Project",
          genre: "玄幻",
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
    assert(referenceItem.sourceType === "markdown", `expected markdown reference, got ${referenceItem.sourceType}`);
    assert(referenceItem.storageKey, "reference upload did not persist storageKey.");

    const references = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/references`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(references, "references listing");

    const reference = references.data.items.find((item) => item.id === referenceItem.id);
    assert(reference, "uploaded reference was not listed.");
    assert(reference.normalizedText?.includes("九州城依河设港"), "uploaded reference normalizedText was missing.");

    const endpoint = await fetchJson(
      `${baseUrl}/api/provider-endpoints`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerType: "openai",
          label: "Mock OpenAI Smoke",
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

    const endpoints = await fetchJson(
      `${baseUrl}/api/provider-endpoints`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(endpoints, "endpoint listing");

    const persistedProviderHealth =
      endpoints.data.items.find((item) => item.id === endpointId)?.healthStatus ?? null;
    assert(persistedProviderHealth === "healthy", `persisted provider health was ${persistedProviderHealth}`);

    const mcpRegistration = await fetchJson(
      `${baseUrl}/api/mcp-servers`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Smoke MCP",
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

    const mcpCapabilities = await fetchJson(
      `${baseUrl}/api/mcp-servers/${mcpId}/capabilities`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(mcpCapabilities, "mcp capabilities");
    assert(mcpCapabilities.data.healthStatus === "healthy", `persisted mcp health was ${mcpCapabilities.data.healthStatus}`);
    assert(mcpCapabilities.data.toolCount === 1, `expected toolCount=1, got ${mcpCapabilities.data.toolCount}`);
    assert(mcpCapabilities.data.resourceCount === 1, `expected resourceCount=1, got ${mcpCapabilities.data.resourceCount}`);
    assert(mcpCapabilities.data.promptCount === 1, `expected promptCount=1, got ${mcpCapabilities.data.promptCount}`);
    assert(
      Array.isArray(mcpCapabilities.data.capabilitiesSnapshot?.resources) &&
        mcpCapabilities.data.capabilitiesSnapshot.resources.some((item) => item.uri === "https://example.com/smoke/reference"),
      "mcp capabilities snapshot did not include the mock resource.",
    );
    assert(
      Array.isArray(mcpCapabilities.data.capabilitiesSnapshot?.prompts) &&
        mcpCapabilities.data.capabilitiesSnapshot.prompts.some((item) => item.name === "review_with_fact"),
      "mcp capabilities snapshot did not include the mock prompt.",
    );

    const mcpResourceRead = await fetchJson(
      `${baseUrl}/api/mcp-servers/${mcpId}/capabilities`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "read_resource",
          uri: "https://example.com/smoke/reference",
        }),
      },
      cookies,
    );
    assertOk(mcpResourceRead, "mcp resource read");
    assert(
      typeof mcpResourceRead.data.combinedText === "string" &&
        mcpResourceRead.data.combinedText.includes("Smoke MCP resource body."),
      "mcp resource read did not return the expected text body.",
    );

    const importedReference = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/references`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filename: "smoke-mcp-reference.txt",
          sourceType: "txt",
          mimeType: mcpResourceRead.data.primaryMimeType ?? "text/plain",
          sourceUrl: "https://example.com/smoke/reference",
          extractionMethod: "mcp_resource_import:Smoke MCP",
          extractedText: mcpResourceRead.data.combinedText,
          normalizedText: mcpResourceRead.data.combinedText,
          tags: ["mcp:Smoke MCP", "mcp-resource"],
        }),
      },
      cookies,
    );
    assertOk(importedReference, "imported mcp resource reference");

    const referencesAfterImport = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/references`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(referencesAfterImport, "references after mcp import");
    const importedReferenceItem = referencesAfterImport.data.items.find((item) => item.id === importedReference.data.id);
    assert(importedReferenceItem, "imported MCP resource reference was not listed.");
    assert(
      importedReferenceItem.normalizedText?.includes("Smoke MCP resource body."),
      "imported MCP resource normalizedText was missing.",
    );

    const mcpPromptPreview = await fetchJson(
      `${baseUrl}/api/mcp-servers/${mcpId}/capabilities`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "get_prompt",
          name: "review_with_fact",
        }),
      },
      cookies,
    );
    assertOk(mcpPromptPreview, "mcp prompt preview");
    assert(
      typeof mcpPromptPreview.data.compiledText === "string" &&
        mcpPromptPreview.data.compiledText.includes("请在输出前先调用 lookup_fact。"),
      "mcp prompt preview did not return the expected prompt text.",
    );

    const providerRequestStart = providerState.requestBodies.length;
    const generate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskType: "review_content",
          userInstruction: "请先调用可用工具，再输出问题、证据、最小修法。",
          endpointId,
          modelId: "gpt-4o-mini",
          selectedArtifactIds: [],
          selectedReferenceIds: [reference.id, importedReference.data.id],
          selectedMcpServerIds: [mcpId],
          generationOptions: {
            temperature: 0,
            externalPromptTemplate: {
              source: "mcp_prompt",
              serverId: mcpId,
              serverName: "Smoke MCP",
              promptName: "review_with_fact",
              content: mcpPromptPreview.data.compiledText,
            },
          },
        }),
      },
      cookies,
    );
    assertOk(generate, "generate");
    assert(typeof generate.data.output === "string" && generate.data.output.includes("问题："), "generate output did not match expected contract.");

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
    assert(draft, "draft was not persisted.");
    assert(run.status === "succeeded", `expected run status succeeded, got ${run.status}`);
    assert(draft.status === "ready", `expected draft status ready, got ${draft.status}`);
    assert(Array.isArray(run.selectedReferenceIds), "generation run selectedReferenceIds was not persisted as an array.");
    assert(run.selectedReferenceIds.includes(reference.id), "generation run did not record the uploaded reference id.");
    assert(
      run.selectedReferenceIds.includes(importedReference.data.id),
      "generation run did not record the imported MCP resource reference id.",
    );

    const toolInventory = Array.isArray(run.toolCallsSummary?.toolInventory) ? run.toolCallsSummary.toolInventory : [];
    const toolCalls = Array.isArray(run.toolCallsSummary?.calls) ? run.toolCallsSummary.calls : [];
    const externalPromptTemplate = run.toolCallsSummary?.externalPromptTemplate ?? null;

    assert(toolInventory.length > 0, "tool inventory was empty.");
    assert(toolCalls.length > 0, "tool call summary was empty.");
    assert(
      toolInventory.some((item) => item.serverId === mcpId && item.namespacedToolName === "smoke_mcp__lookup_fact"),
      "expected namespaced MCP tool was not recorded.",
    );
    assert(
      toolCalls.some((item) => item.toolName === "smoke_mcp__lookup_fact" && item.output),
      "expected MCP tool call output was not recorded.",
    );
    assert(externalPromptTemplate, "externalPromptTemplate summary was not recorded.");
    assert(
      externalPromptTemplate.promptName === "review_with_fact",
      `unexpected externalPromptTemplate promptName ${externalPromptTemplate?.promptName}`,
    );
    assert(
      typeof externalPromptTemplate.preview === "string" &&
        externalPromptTemplate.preview.includes("请在输出前先调用 lookup_fact。"),
      "externalPromptTemplate preview did not include the MCP prompt text.",
    );

    const generationRequestBodies = providerState.requestBodies.slice(providerRequestStart);
    const generationRequestText = generationRequestBodies.map((body) => extractBodyText(body)).join("\n");
    assert(
      generationRequestText.includes("请在输出前先调用 lookup_fact。"),
      "provider request did not include the applied MCP prompt template.",
    );
    assert(
      generationRequestText.includes("Smoke MCP resource body."),
      "provider request did not include the imported MCP resource content.",
    );

    assert(providerState.requestBodies.length >= 3, `expected >=3 provider requests, got ${providerState.requestBodies.length}`);
    assert(mcpState.requestCount >= 2, `expected MCP server to receive requests, got ${mcpState.requestCount}`);

    const artifacts = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(artifacts, "artifacts listing");

    const targetFilename = Array.isArray(generate.data.suggestedPatches) ? generate.data.suggestedPatches[0] : null;
    const artifact = artifacts.data.items.find((item) => item.filename === targetFilename);
    const progressArtifact = artifacts.data.items.find((item) => item.filename === "progress.md");
    const currentStateArtifact = artifacts.data.items.find((item) => item.filename === "99_当前状态卡.md");
    assert(artifact, `artifact for suggested patch ${targetFilename} was not found.`);
    assert(progressArtifact, "progress.md artifact was not found.");
    assert(currentStateArtifact, "99_当前状态卡.md artifact was not found.");

    const projectBeforeAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(projectBeforeAccept, "project before accept");
    const previousProjectUpdatedAt = Date.parse(projectBeforeAccept.data.updatedAt);

    const artifactBeforeAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${artifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(artifactBeforeAccept, "artifact before accept");

    const previousCurrentRevisionId = artifactBeforeAccept.data.currentRevision?.id ?? null;
    const previousRevisionCount = Array.isArray(artifactBeforeAccept.data.revisions)
      ? artifactBeforeAccept.data.revisions.length
      : 0;

    const accept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts/${draft.id}/accept`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          artifactId: artifact.id,
          summary: "Smoke accept revision",
        }),
      },
      cookies,
    );
    assertOk(accept, "draft accept");

    const draftsAfterAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(draftsAfterAccept, "drafts after accept");

    const acceptedDraft = draftsAfterAccept.data.items.find((item) => item.id === draft.id);
    assert(acceptedDraft?.status === "accepted", `expected accepted draft status, got ${acceptedDraft?.status}`);

    const artifactAfterAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${artifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(artifactAfterAccept, "artifact after accept");

    const currentRevision = artifactAfterAccept.data.currentRevision;
    const revisionList = Array.isArray(artifactAfterAccept.data.revisions) ? artifactAfterAccept.data.revisions : [];

    assert(currentRevision, "artifact currentRevision was not updated.");
    assert(currentRevision.id === accept.data.id, "accept response revision id did not become currentRevision.");
    assert(currentRevision.id !== previousCurrentRevisionId, "currentRevision id did not change after accept.");
    assert(currentRevision.content === draft.outputContent, "accepted revision content did not match draft output.");
    assert(currentRevision.summary === "Smoke accept revision", `unexpected revision summary ${currentRevision.summary}`);
    assert(revisionList.length >= previousRevisionCount + 1, "artifact revision list did not grow after accept.");
    assert(accept.data.sourceDraftId === draft.id, "accepted revision sourceDraftId mismatch.");
    assert(accept.data.sourceRunId === run.id, "accepted revision sourceRunId mismatch.");
    assert(Array.isArray(accept.data.syncedArtifacts), "accept response did not include syncedArtifacts.");

    const progressAfterAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${progressArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(progressAfterAccept, "progress artifact after accept");
    assert(
      progressAfterAccept.data.currentRevision?.content?.includes("## 接受日志"),
      "progress artifact was not updated with accept log.",
    );
    assert(
      progressAfterAccept.data.currentRevision?.content?.includes("findings.md <- review_content: Smoke accept revision"),
      "progress artifact accept log did not record the accepted artifact.",
    );

    const currentStateAfterAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${currentStateArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(currentStateAfterAccept, "current state artifact after accept");
    assert(
      currentStateAfterAccept.data.currentRevision?.content?.includes("## 自动同步记录"),
      "current state artifact was not updated with auto sync content.",
    );
    assert(
      currentStateAfterAccept.data.currentRevision?.content?.includes("最近回填文件：findings.md"),
      "current state artifact did not record the accepted artifact.",
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

    console.log(
      JSON.stringify({
        baseUrl,
        providerBaseUrl,
        mcpServerUrl,
        projectId,
        endpointId,
        mcpId,
        runId: generate.data.runId,
        draftId: generate.data.draftId,
        referenceId: reference.id,
        acceptedArtifactId: artifact.id,
        revisionId: accept.data.id,
        providerHealthStatus: providerHealth.data.status,
        mcpHealthStatus: mcpHealth.data.status,
        toolInventoryCount: toolInventory.length,
        toolCallCount: toolCalls.length,
        importedReferenceId: importedReference.data.id,
        syncedArtifactCount: accept.data.syncedArtifacts.length,
        providerRequestCount: providerState.requestBodies.length,
        mcpRequestCount: mcpState.requestCount,
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
