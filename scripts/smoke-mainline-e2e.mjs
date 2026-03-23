import http from "node:http";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import process from "node:process";

const nextPort = Number(process.env.NEXT_SMOKE_PORT || 3112);
const providerPort = Number(process.env.MOCK_PROVIDER_PORT || 3122);
const grokPort = Number(process.env.MOCK_GROK_PORT || 3132);
const loopbackAlias = process.env.SMOKE_LOOPBACK_HOST || "localhost.localstack.cloud";

const baseUrl = `http://localhost:${nextPort}`;
const providerBaseUrl = `http://${loopbackAlias}:${providerPort}/v1`;
const grokBaseUrl = `http://${loopbackAlias}:${grokPort}`;
const nextBin = "node_modules/next/dist/bin/next";

const referenceMarker = "九州城依河设港，秋季船期更密，夜间货栈会按照潮汐钟点安排装卸与清点税票。";
const settingMarker = "潮汐钟契约";
const outlineMarker = "第一卷：港口起势";
const researchFactMarker = "秋季船期更密，税票改革后夜航窗口更集中。";
const chapterBodyMarker =
  "周敬安把让渡仓位凭据按在账册上，等对方先露底牌，再把抽成比例一寸寸压回自己这边。";
const reviewIssueMarker = "问题：主角在确认利益交换前推进得还是偏快。";
const minimalFixMarker =
  "他先把对方递来的让渡仓位凭据按在灯下核了两遍，确认筹码真能落袋，才开口把抽成谈到自己想要的位置。";
const syncStateMarker = "当前状态已推进到夜班仓位谈判落稿，可进入下一章成本回收。";

const settingUserInstruction = "请补齐港口商战题材的世界规则、地理分区和限制条件。";
const outlineUserInstruction = "请基于当前设定生成第一卷卷纲、节拍表和关键回收点。";
const researchUserInstruction = "请核查晚清港口秋季船期与税票改革对夜航仓位分配的影响。";
const chapterUserInstruction = "请基于已确认设定、卷纲和考据结论续写当前章节，重点写夜班仓位谈判。";
const reviewUserInstruction = "请审查当前章节，按问题、证据、最小修法输出。";
const syncStateUserInstruction = "请根据最新设定、卷纲、考据结论与章节修订结果，同步进度记录与当前状态卡。";

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
      taskKind: "generate_setting",
      index: findFirstMarkerIndex(haystack, ["generate_setting", "设定生成", settingUserInstruction, settingMarker]),
    },
    {
      taskKind: "generate_outline",
      index: findFirstMarkerIndex(haystack, ["generate_outline", "卷纲与节拍表生成", outlineUserInstruction, outlineMarker]),
    },
    {
      taskKind: "research_fact_check",
      index: findFirstMarkerIndex(haystack, [
        "research_fact_check",
        "考据与事实核查",
        researchUserInstruction,
        researchFactMarker,
      ]),
    },
    {
      taskKind: "generate_chapter",
      index: findFirstMarkerIndex(haystack, [
        "generate_chapter",
        "正文生成",
        chapterUserInstruction,
        chapterBodyMarker,
      ]),
    },
    {
      taskKind: "review_content",
      index: findFirstMarkerIndex(haystack, [
        "review_content",
        "质量审查",
        reviewUserInstruction,
        reviewIssueMarker,
      ]),
    },
    {
      taskKind: "minimal_fix",
      index: findFirstMarkerIndex(haystack, ["minimal_fix", "最小修法改写", "已确认审稿意见", minimalFixMarker]),
    },
    {
      taskKind: "sync_state",
      index: findFirstMarkerIndex(haystack, [
        "sync_state",
        "状态回填",
        syncStateUserInstruction,
        syncStateMarker,
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
    case "generate_setting":
      return [
        "# 世界设定补全",
        "",
        "## 世界规则",
        `九州城的港务体系以“${settingMarker}”为约束，夜间装卸、税契和仓位分配都围绕这套约定运转。`,
        "",
        "## 地理分区",
        "九州城分为上游官埠、中段商栈和下游黑平码头三段，潮位变化直接影响各家夜班收益。",
        "",
        "## 角色约束",
        "主角的优势不是超凡能力，而是对仓单、税票和靠港顺序的精准拆解。",
        "",
        "## 禁忌与限制",
        "任何公开违背潮汐钟契约的势力，都会在次日被官埠暂停优先靠港资格。",
        "",
        "## 建议回填补丁",
        "- world_bible.md",
      ].join("\n");
    case "generate_outline":
      return [
        `# ${outlineMarker}`,
        "",
        "## 卷纲",
        `主线围绕“${settingMarker}”展开，主角先借夜班仓位分配撬开港口利益链，再把对手逼到必须让出优先装卸窗口。`,
        "",
        "## 节拍表",
        "1. 发现夜班仓位调度里的税票漏洞，确认第一批可以套利的船次。",
        "2. 借让渡仓位换抽成，迫使对手暴露真实现金流压力。",
        "3. 通过官埠与商栈的双线博弈，完成第一轮势力站位。",
        "",
        "## 关键回收点",
        "- 回收世界规则里的潮汐钟契约，证明它既是秩序也是武器。",
        "- 在卷末把优先靠港资格与主角长期收益绑定，给下一卷留下扩张口子。",
        "",
        "## 需要更新的项目文件",
        "- task_plan.md",
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
        "## 冲突点",
        "- 港口年鉴更强调到港量增幅，税务公报更强调清点顺序调整；两者对事实方向一致，但口径侧重点不同。",
        "",
        "## 可写入项目的事实补充",
        `- findings.md：${researchFactMarker}`,
      ].join("\n");
    case "generate_chapter":
      return [
        "【写作自检】",
        `- 世界约束：${settingMarker}`,
        `- 卷纲节点：${outlineMarker}`,
        `- 事实锚点：${researchFactMarker}`,
        "",
        "正文",
        "周敬安没有急着压价，先把夜潮钟、仓单和税票底册逐项核了一遍，确认今夜卸货窗口确实会集中到后半夜。",
        chapterBodyMarker,
        "",
        "【建议回填】",
        "- progress.md",
        "- 99_当前状态卡.md",
      ].join("\n");
    case "review_content":
      return [
        reviewIssueMarker,
        `证据：当前稿件已经写到“${chapterBodyMarker}”，但在 ${researchFactMarker} 之后，还缺一拍让主角确认对方愿意让出优先仓位。`,
        "最小修法：在主角开口压价前，加一句他先核对让渡仓位凭据、确认好处可以落袋，再决定推进谈判。",
      ].join("\n");
    case "minimal_fix":
      return [
        "周敬安没有急着压价，先把夜潮钟、仓单和税票底册逐项核了一遍，确认今夜卸货窗口确实会集中到后半夜。",
        minimalFixMarker,
        "",
        "修改摘要：补入主角确认让渡仓位凭据的动作，让利益交换链条完整落地。",
        "建议回填项：progress.md / 99_当前状态卡.md",
      ].join("\n");
    case "sync_state":
      return [
        "# progress 同步结果",
        "",
        "## 进度记录",
        "| 时间 | 章节/节点 | 推进内容 | 待跟进 |",
        "| --- | --- | --- | --- |",
        `| 当前轮 | ${outlineMarker} | 已确认 ${settingMarker}、${researchFactMarker}，并完成夜班仓位谈判修订稿 | 推进下一章成本回收与对手反制 |`,
        "",
        "## 需更新的文件清单",
        "- progress.md",
        "- 99_当前状态卡.md",
        "",
        "## 补丁内容",
        `- progress.md: 记录 ${outlineMarker} 已推进到夜班仓位谈判落稿。`,
        `- 99_当前状态卡.md: ${syncStateMarker}`,
        "",
        "## 本次同步摘要",
        `- ${syncStateMarker}`,
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
      input_tokens: 72,
      output_tokens: 56,
      total_tokens: 128,
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
      prompt_tokens: 72,
      completion_tokens: 56,
      total_tokens: 128,
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
  expectedSyncedArtifactsCount = 2,
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
  assert(
    acceptResponse.data.syncedArtifacts.length === expectedSyncedArtifactsCount,
    `${label} accept should have synced ${expectedSyncedArtifactsCount} artifacts.`,
  );
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

    const email = `smoke-mainline-e2e-${Date.now()}@example.com`;
    const signup = await fetchJson(`${baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Smoke Mainline E2E Tester",
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
          name: "Smoke Mainline Project",
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
          `# 港口考据笔记\n\n${referenceMarker}\n夜班仓位会优先分配给已经完成税票核验的船只。`,
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

    const worldBibleArtifact = findArtifactBy(
      artifactsInitial.data.items,
      (item) => item.artifactKey === "world_bible",
      "world bible artifact",
    );
    const taskPlanArtifact = findArtifactBy(
      artifactsInitial.data.items,
      (item) => item.artifactKey === "task_plan",
      "task plan artifact",
    );
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
          label: "Mock OpenAI Mainline Smoke",
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

    const worldBibleBeforeSettingAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${worldBibleArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(worldBibleBeforeSettingAccept, "world bible before setting accept");

    const settingGenerate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskType: "generate_setting",
          userInstruction: settingUserInstruction,
          endpointId,
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
    assertOk(settingGenerate, "generate_setting generate");
    assert(
      typeof settingGenerate.data.output === "string" &&
        settingGenerate.data.output.includes("## 世界规则") &&
        settingGenerate.data.output.includes(settingMarker),
      "generate_setting output did not match expected contract.",
    );

    const runsAfterSettingGenerate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/runs`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(runsAfterSettingGenerate, "runs after setting generate");

    const draftsAfterSettingGenerate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(draftsAfterSettingGenerate, "drafts after setting generate");

    const settingRun = findItemById(
      runsAfterSettingGenerate.data.items,
      settingGenerate.data.runId,
      "generate_setting run",
    );
    const settingDraft = findItemById(
      draftsAfterSettingGenerate.data.items,
      settingGenerate.data.draftId,
      "generate_setting draft",
    );

    assert(settingRun.status === "succeeded", `generate_setting run status was ${settingRun.status}`);
    assert(settingDraft.status === "ready", `generate_setting draft status was ${settingDraft.status}`);
    assertResolvedArtifactKeys(
      settingRun,
      ["story_background", "world_bible", "protagonist_card", "factions_and_characters", "writing_rules"],
      "generate_setting run",
    );

    const settingAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts/${settingDraft.id}/accept`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          artifactId: worldBibleArtifact.id,
          summary: "Smoke setting accept revision",
        }),
      },
      cookies,
    );
    assertOk(settingAccept, "generate_setting accept");

    const worldBibleAfterSettingAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${worldBibleArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(worldBibleAfterSettingAccept, "world bible after setting accept");
    assertAcceptedRevision({
      acceptResponse: settingAccept,
      artifactAfterAccept: worldBibleAfterSettingAccept,
      generatedOutput: settingGenerate.data.output,
      expectedSummary: "Smoke setting accept revision",
      previousRevisionId: worldBibleBeforeSettingAccept.data.currentRevision?.id ?? null,
      previousRevisionCount: Array.isArray(worldBibleBeforeSettingAccept.data.revisions)
        ? worldBibleBeforeSettingAccept.data.revisions.length
        : 0,
      expectedDraftId: settingDraft.id,
      expectedRunId: settingRun.id,
      label: "generate_setting accept",
    });

    const taskPlanBeforeOutlineAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${taskPlanArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(taskPlanBeforeOutlineAccept, "task plan before outline accept");

    const providerRequestStartBeforeOutline = providerState.requests.length;
    const outlineGenerate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskType: "generate_outline",
          userInstruction: outlineUserInstruction,
          endpointId,
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
    assertOk(outlineGenerate, "generate_outline generate");
    assert(
      typeof outlineGenerate.data.output === "string" &&
        outlineGenerate.data.output.includes("## 卷纲") &&
        outlineGenerate.data.output.includes("## 节拍表") &&
        outlineGenerate.data.output.includes(settingMarker),
      "generate_outline output did not match expected contract.",
    );

    const outlineRequestBodies = providerState.requests.slice(providerRequestStartBeforeOutline);
    const outlineRequestText = outlineRequestBodies.map((request) => extractBodyText(request.body)).join("\n");
    assert(
      outlineRequestText.includes(settingMarker),
      "generate_outline request did not include the accepted generate_setting content from world_bible.",
    );

    const runsAfterOutlineGenerate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/runs`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(runsAfterOutlineGenerate, "runs after outline generate");

    const draftsAfterOutlineGenerate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(draftsAfterOutlineGenerate, "drafts after outline generate");

    const outlineRun = findItemById(
      runsAfterOutlineGenerate.data.items,
      outlineGenerate.data.runId,
      "generate_outline run",
    );
    const outlineDraft = findItemById(
      draftsAfterOutlineGenerate.data.items,
      outlineGenerate.data.draftId,
      "generate_outline draft",
    );

    assert(outlineRun.status === "succeeded", `generate_outline run status was ${outlineRun.status}`);
    assert(outlineDraft.status === "ready", `generate_outline draft status was ${outlineDraft.status}`);
    assertResolvedArtifactKeys(
      outlineRun,
      ["story_background", "world_bible", "protagonist_card", "writing_rules", "task_plan"],
      "generate_outline run",
    );

    const outlineAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts/${outlineDraft.id}/accept`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          artifactId: taskPlanArtifact.id,
          summary: "Smoke outline accept revision",
        }),
      },
      cookies,
    );
    assertOk(outlineAccept, "generate_outline accept");

    const taskPlanAfterOutlineAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${taskPlanArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(taskPlanAfterOutlineAccept, "task plan after outline accept");
    assertAcceptedRevision({
      acceptResponse: outlineAccept,
      artifactAfterAccept: taskPlanAfterOutlineAccept,
      generatedOutput: outlineGenerate.data.output,
      expectedSummary: "Smoke outline accept revision",
      previousRevisionId: taskPlanBeforeOutlineAccept.data.currentRevision?.id ?? null,
      previousRevisionCount: Array.isArray(taskPlanBeforeOutlineAccept.data.revisions)
        ? taskPlanBeforeOutlineAccept.data.revisions.length
        : 0,
      expectedDraftId: outlineDraft.id,
      expectedRunId: outlineRun.id,
      label: "generate_outline accept",
    });

    const findingsBeforeResearchAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${findingsArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(findingsBeforeResearchAccept, "findings before research accept");

    const providerRequestStartBeforeResearch = providerState.requests.length;
    const grokRequestStartBeforeResearch = grokState.requests.length;
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
          selectedArtifactIds: [worldBibleArtifact.id, taskPlanArtifact.id],
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

    const providerRequestsForResearch = providerState.requests.slice(providerRequestStartBeforeResearch);
    const providerResearchText = providerRequestsForResearch.map((request) => extractBodyText(request.body)).join("\n");
    assert(
      providerResearchText.includes("以下内容来自 GrokSearch"),
      "research_fact_check prompt did not include the GrokSearch external facts section.",
    );
    assert(
      providerResearchText.includes("Harbor Report") &&
        providerResearchText.includes("https://example.com/customs-bulletin"),
      "research_fact_check prompt did not include the resolved GrokSearch source summaries.",
    );
    assert(
      providerResearchText.includes(referenceMarker),
      "research_fact_check prompt did not include the selected reference content.",
    );
    assert(
      providerResearchText.includes(settingMarker) && providerResearchText.includes(outlineMarker),
      "research_fact_check prompt did not include the accepted setting and outline context.",
    );

    const grokRequestsForResearch = grokState.requests.slice(grokRequestStartBeforeResearch);
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
      Array.isArray(researchRun.selectedArtifactIds) &&
        researchRun.selectedArtifactIds.includes(worldBibleArtifact.id) &&
        researchRun.selectedArtifactIds.includes(taskPlanArtifact.id),
      "research_fact_check run did not persist the selected setting and outline artifact ids.",
    );
    assert(
      Array.isArray(researchRun.selectedReferenceIds) &&
        researchRun.selectedReferenceIds.includes(referenceItem.id),
      "research_fact_check run did not persist the selected reference id.",
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

    const findingsAfterResearchAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${findingsArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(findingsAfterResearchAccept, "findings after research accept");
    assertAcceptedRevision({
      acceptResponse: researchAccept,
      artifactAfterAccept: findingsAfterResearchAccept,
      generatedOutput: researchGenerate.data.output,
      expectedSummary: "Smoke research accept revision",
      previousRevisionId: findingsBeforeResearchAccept.data.currentRevision?.id ?? null,
      previousRevisionCount: Array.isArray(findingsBeforeResearchAccept.data.revisions)
        ? findingsBeforeResearchAccept.data.revisions.length
        : 0,
      expectedDraftId: researchDraft.id,
      expectedRunId: researchRun.id,
      label: "research_fact_check accept",
    });

    const chapterBeforeChapterAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${chapterArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(chapterBeforeChapterAccept, "chapter before chapter accept");

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
          selectedArtifactIds: [worldBibleArtifact.id, taskPlanArtifact.id, findingsArtifact.id],
          selectedReferenceIds: [],
          selectedMcpServerIds: [],
          generationOptions: {
            temperature: 0,
            maxTokens: 1400,
          },
        }),
      },
      cookies,
    );
    assertOk(chapterGenerate, "generate_chapter generate");
    assert(
      typeof chapterGenerate.data.output === "string" &&
        chapterGenerate.data.output.includes("【写作自检】") &&
        chapterGenerate.data.output.includes("正文") &&
        chapterGenerate.data.output.includes(chapterBodyMarker),
      "generate_chapter output did not match the expected contract.",
    );

    const chapterProviderRequests = providerState.requests.slice(providerRequestStartBeforeChapter);
    const chapterProviderText = chapterProviderRequests.map((request) => extractBodyText(request.body)).join("\n");
    assert(
      chapterProviderText.includes(settingMarker) &&
        chapterProviderText.includes(outlineMarker) &&
        chapterProviderText.includes(researchFactMarker),
      "generate_chapter prompt did not include the accepted setting, outline, and research findings.",
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

    const draftsAfterChapterGenerate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(draftsAfterChapterGenerate, "drafts after chapter generate");

    const chapterRun = findItemById(
      runsAfterChapterGenerate.data.items,
      chapterGenerate.data.runId,
      "generate_chapter run",
    );
    const chapterDraft = findItemById(
      draftsAfterChapterGenerate.data.items,
      chapterGenerate.data.draftId,
      "generate_chapter draft",
    );

    assert(chapterRun.status === "succeeded", `generate_chapter run status was ${chapterRun.status}`);
    assert(chapterDraft.status === "ready", `generate_chapter draft status was ${chapterDraft.status}`);
    assertResolvedArtifactKeys(
      chapterRun,
      ["writing_rules", "task_plan", "findings", "progress", "current_state_card"],
      "generate_chapter run",
    );

    const chapterAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts/${chapterDraft.id}/accept`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          artifactId: chapterArtifact.id,
          summary: "Smoke chapter accept revision",
        }),
      },
      cookies,
    );
    assertOk(chapterAccept, "generate_chapter accept");
    assert(chapterAccept.data.chapter?.status === "accepted", "chapter accept did not update chapterIndex status to accepted.");

    const chapterAfterChapterAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${chapterArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(chapterAfterChapterAccept, "chapter after chapter accept");
    assertAcceptedRevision({
      acceptResponse: chapterAccept,
      artifactAfterAccept: chapterAfterChapterAccept,
      generatedOutput: chapterGenerate.data.output,
      expectedSummary: "Smoke chapter accept revision",
      previousRevisionId: chapterBeforeChapterAccept.data.currentRevision?.id ?? null,
      previousRevisionCount: Array.isArray(chapterBeforeChapterAccept.data.revisions)
        ? chapterBeforeChapterAccept.data.revisions.length
        : 0,
      expectedDraftId: chapterDraft.id,
      expectedRunId: chapterRun.id,
      label: "generate_chapter accept",
    });

    const findingsBeforeReviewAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${findingsArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(findingsBeforeReviewAccept, "findings before review accept");

    const providerRequestStartBeforeReview = providerState.requests.length;
    const reviewGenerate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskType: "review_content",
          userInstruction: reviewUserInstruction,
          endpointId,
          modelId: "gpt-4o-mini",
          selectedArtifactIds: [chapterArtifact.id],
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
    assertOk(reviewGenerate, "review_content generate");
    assert(
      typeof reviewGenerate.data.output === "string" &&
        reviewGenerate.data.output.includes(reviewIssueMarker) &&
        reviewGenerate.data.output.includes("证据：") &&
        reviewGenerate.data.output.includes("最小修法："),
      "review_content output did not match the expected contract.",
    );

    const reviewRequests = providerState.requests.slice(providerRequestStartBeforeReview);
    const reviewRequestText = reviewRequests.map((request) => extractBodyText(request.body)).join("\n");
    assert(
      reviewRequestText.includes(chapterBodyMarker),
      "review_content prompt did not include the accepted chapter content.",
    );

    const runsAfterReviewGenerate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/runs`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(runsAfterReviewGenerate, "runs after review generate");

    const draftsAfterReviewGenerate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(draftsAfterReviewGenerate, "drafts after review generate");

    const reviewRun = findItemById(
      runsAfterReviewGenerate.data.items,
      reviewGenerate.data.runId,
      "review_content run",
    );
    const reviewDraft = findItemById(
      draftsAfterReviewGenerate.data.items,
      reviewGenerate.data.draftId,
      "review_content draft",
    );

    assert(reviewRun.status === "succeeded", `review_content run status was ${reviewRun.status}`);
    assert(reviewDraft.status === "ready", `review_content draft status was ${reviewDraft.status}`);

    const reviewAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts/${reviewDraft.id}/accept`,
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
    assertOk(reviewAccept, "review_content accept");

    const findingsAfterReviewAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${findingsArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(findingsAfterReviewAccept, "findings after review accept");
    assertAcceptedRevision({
      acceptResponse: reviewAccept,
      artifactAfterAccept: findingsAfterReviewAccept,
      generatedOutput: reviewGenerate.data.output,
      expectedSummary: "Smoke review accept revision",
      previousRevisionId: findingsBeforeReviewAccept.data.currentRevision?.id ?? null,
      previousRevisionCount: Array.isArray(findingsBeforeReviewAccept.data.revisions)
        ? findingsBeforeReviewAccept.data.revisions.length
        : 0,
      expectedDraftId: reviewDraft.id,
      expectedRunId: reviewRun.id,
      label: "review_content accept",
    });

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
      `${baseUrl}/api/projects/${projectId}/artifacts/${chapterArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(chapterBeforeMinimalFixAccept, "chapter before minimal fix accept");

    const providerRequestStartBeforeMinimalFix = providerState.requests.length;
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
            reviewGenerate.data.output,
          ].join("\n"),
          endpointId,
          modelId: "gpt-4o-mini",
          targetArtifactId: chapterArtifact.id,
          selectedArtifactIds: [findingsArtifact.id, currentStateArtifact.id],
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
    assertOk(minimalFixGenerate, "minimal_fix generate");
    assert(
      typeof minimalFixGenerate.data.output === "string" &&
        minimalFixGenerate.data.output.includes(minimalFixMarker) &&
        minimalFixGenerate.data.output.includes("修改摘要：") &&
        minimalFixGenerate.data.output.includes("建议回填项："),
      "minimal_fix output did not match the expected contract.",
    );

    const minimalFixRequests = providerState.requests.slice(providerRequestStartBeforeMinimalFix);
    const minimalFixRequestText = minimalFixRequests.map((request) => extractBodyText(request.body)).join("\n");
    assert(
      minimalFixRequestText.includes(reviewIssueMarker),
      "minimal_fix generation did not include the accepted review findings in its request context.",
    );

    const runsAfterMinimalFixGenerate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/runs`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(runsAfterMinimalFixGenerate, "runs after minimal fix generate");

    const draftsAfterMinimalFixGenerate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(draftsAfterMinimalFixGenerate, "drafts after minimal fix generate");

    const minimalFixRun = findItemById(
      runsAfterMinimalFixGenerate.data.items,
      minimalFixGenerate.data.runId,
      "minimal_fix run",
    );
    const minimalFixDraft = findItemById(
      draftsAfterMinimalFixGenerate.data.items,
      minimalFixGenerate.data.draftId,
      "minimal_fix draft",
    );

    assert(minimalFixRun.status === "succeeded", `minimal_fix run status was ${minimalFixRun.status}`);
    assert(minimalFixDraft.status === "ready", `minimal_fix draft status was ${minimalFixDraft.status}`);

    const minimalFixAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts/${minimalFixDraft.id}/accept`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          artifactId: chapterArtifact.id,
          summary: "Smoke minimal fix accept revision",
        }),
      },
      cookies,
    );
    assertOk(minimalFixAccept, "minimal_fix accept");
    assert(
      minimalFixAccept.data.chapter?.status === "accepted",
      "minimal_fix accept did not leave the chapter in accepted status.",
    );

    const chapterAfterMinimalFixAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${chapterArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(chapterAfterMinimalFixAccept, "chapter after minimal fix accept");
    assertAcceptedRevision({
      acceptResponse: minimalFixAccept,
      artifactAfterAccept: chapterAfterMinimalFixAccept,
      generatedOutput: minimalFixGenerate.data.output,
      expectedSummary: "Smoke minimal fix accept revision",
      previousRevisionId: chapterBeforeMinimalFixAccept.data.currentRevision?.id ?? null,
      previousRevisionCount: Array.isArray(chapterBeforeMinimalFixAccept.data.revisions)
        ? chapterBeforeMinimalFixAccept.data.revisions.length
        : 0,
      expectedDraftId: minimalFixDraft.id,
      expectedRunId: minimalFixRun.id,
      label: "minimal_fix accept",
    });

    const progressBeforeSyncStateAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${progressArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(progressBeforeSyncStateAccept, "progress before sync_state accept");

    const currentStateBeforeSyncStateAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${currentStateArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(currentStateBeforeSyncStateAccept, "current state before sync_state accept");

    const providerRequestStartBeforeSyncState = providerState.requests.length;
    const syncStateGenerate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskType: "sync_state",
          userInstruction: syncStateUserInstruction,
          endpointId,
          modelId: "gpt-4o-mini",
          selectedArtifactIds: [worldBibleArtifact.id, taskPlanArtifact.id, chapterArtifact.id],
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
    assertOk(syncStateGenerate, "sync_state generate");
    assert(
      typeof syncStateGenerate.data.output === "string" &&
        syncStateGenerate.data.output.includes("## 需更新的文件清单") &&
        syncStateGenerate.data.output.includes(syncStateMarker),
      "sync_state output did not match expected contract.",
    );
    assert(
      Array.isArray(syncStateGenerate.data.suggestedPatches) &&
        syncStateGenerate.data.suggestedPatches.includes("progress.md") &&
        syncStateGenerate.data.suggestedPatches.includes("99_当前状态卡.md"),
      "sync_state did not suggest both progress.md and 99_当前状态卡.md.",
    );

    const syncStateRequests = providerState.requests.slice(providerRequestStartBeforeSyncState);
    const syncStateRequestText = syncStateRequests.map((request) => extractBodyText(request.body)).join("\n");
    assert(
      syncStateRequestText.includes(settingMarker) &&
        syncStateRequestText.includes(outlineMarker) &&
        syncStateRequestText.includes(minimalFixMarker),
      "sync_state prompt did not include the accepted setting, outline, and fixed chapter content.",
    );
    assert(
      syncStateRequestText.includes(reviewIssueMarker),
      "sync_state prompt did not include the accepted review findings context.",
    );

    const runsAfterSyncStateGenerate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/runs`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(runsAfterSyncStateGenerate, "runs after sync_state generate");

    const draftsAfterSyncStateGenerate = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(draftsAfterSyncStateGenerate, "drafts after sync_state generate");

    const syncStateRun = findItemById(
      runsAfterSyncStateGenerate.data.items,
      syncStateGenerate.data.runId,
      "sync_state run",
    );
    const syncStateDraft = findItemById(
      draftsAfterSyncStateGenerate.data.items,
      syncStateGenerate.data.draftId,
      "sync_state draft",
    );

    assert(syncStateRun.status === "succeeded", `sync_state run status was ${syncStateRun.status}`);
    assert(syncStateDraft.status === "ready", `sync_state draft status was ${syncStateDraft.status}`);
    assert(syncStateDraft.draftKind === "generated_output", "sync_state draftKind was not generated_output.");
    assertResolvedArtifactKeys(
      syncStateRun,
      ["findings", "progress", "current_state_card", "world_bible", "task_plan"],
      "sync_state run",
    );

    const syncStateAccept = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts/${syncStateDraft.id}/accept`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          artifactId: currentStateArtifact.id,
          summary: "Smoke sync state accept revision",
        }),
      },
      cookies,
    );
    assertOk(syncStateAccept, "sync_state accept");

    const progressAfterAllAccepts = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${progressArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(progressAfterAllAccepts, "progress after all accepts");
    assert(
      progressAfterAllAccepts.data.currentRevision?.id !== progressBeforeSyncStateAccept.data.currentRevision?.id,
      "progress currentRevision id did not change after sync_state auto-sync.",
    );
    assert(
      progressAfterAllAccepts.data.currentRevision?.summary === "Auto sync after accepting 99_当前状态卡.md",
      "progress auto-sync summary did not persist after sync_state accept.",
    );
    assert(
      (Array.isArray(progressAfterAllAccepts.data.revisions) ? progressAfterAllAccepts.data.revisions.length : 0) >=
        (Array.isArray(progressBeforeSyncStateAccept.data.revisions) ? progressBeforeSyncStateAccept.data.revisions.length : 0) + 1,
      "progress revision list did not grow after sync_state auto-sync.",
    );
    assert(
      progressAfterAllAccepts.data.currentRevision?.content?.includes("## 接受日志"),
      "progress artifact did not keep the accept log block.",
    );
    assert(
      progressAfterAllAccepts.data.currentRevision?.content?.includes(
        "world_bible.md <- generate_setting: Smoke setting accept revision",
      ),
      "progress artifact did not record the generate_setting acceptance.",
    );
    assert(
      progressAfterAllAccepts.data.currentRevision?.content?.includes(
        "task_plan.md <- generate_outline: Smoke outline accept revision",
      ),
      "progress artifact did not record the generate_outline acceptance.",
    );
    assert(
      progressAfterAllAccepts.data.currentRevision?.content?.includes(
        "findings.md <- research_fact_check: Smoke research accept revision",
      ),
      "progress artifact did not record the research_fact_check acceptance.",
    );
    assert(
      progressAfterAllAccepts.data.currentRevision?.content?.includes(
        `${chapterArtifact.filename} <- generate_chapter: Smoke chapter accept revision`,
      ),
      "progress artifact did not record the generate_chapter acceptance.",
    );
    assert(
      progressAfterAllAccepts.data.currentRevision?.content?.includes(
        "findings.md <- review_content: Smoke review accept revision",
      ),
      "progress artifact did not record the review_content acceptance.",
    );
    assert(
      progressAfterAllAccepts.data.currentRevision?.content?.includes(
        `${chapterArtifact.filename} <- minimal_fix: Smoke minimal fix accept revision`,
      ),
      "progress artifact did not record the minimal_fix acceptance.",
    );
    assert(
      progressAfterAllAccepts.data.currentRevision?.content?.includes(
        "99_当前状态卡.md <- sync_state: Smoke sync state accept revision",
      ),
      "progress artifact did not record the sync_state acceptance.",
    );

    const currentStateAfterAllAccepts = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/artifacts/${currentStateArtifact.id}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(currentStateAfterAllAccepts, "current state after all accepts");
    assert(
      currentStateAfterAllAccepts.data.currentRevision?.id === syncStateAccept.data.id,
      "sync_state accept did not become the current state currentRevision.",
    );
    assert(
      currentStateAfterAllAccepts.data.currentRevision?.id !== currentStateBeforeSyncStateAccept.data.currentRevision?.id,
      "current state currentRevision id did not change after sync_state accept.",
    );
    assert(
      currentStateAfterAllAccepts.data.currentRevision?.content?.includes(syncStateGenerate.data.output.trim()),
      "current state currentRevision did not keep the sync_state generated output.",
    );
    assert(
      currentStateAfterAllAccepts.data.currentRevision?.summary === "Smoke sync state accept revision",
      "current state revision summary did not persist after sync_state accept.",
    );
    assert(
      (Array.isArray(currentStateAfterAllAccepts.data.revisions) ? currentStateAfterAllAccepts.data.revisions.length : 0) >=
        (Array.isArray(currentStateBeforeSyncStateAccept.data.revisions)
          ? currentStateBeforeSyncStateAccept.data.revisions.length
          : 0) + 1,
      "current state revision list did not grow after sync_state accept.",
    );
    assert(
      syncStateAccept.data.sourceDraftId === syncStateDraft.id,
      "sync_state accept sourceDraftId mismatch.",
    );
    assert(
      syncStateAccept.data.sourceRunId === syncStateRun.id,
      "sync_state accept sourceRunId mismatch.",
    );
    assert(
      Array.isArray(syncStateAccept.data.syncedArtifacts) && syncStateAccept.data.syncedArtifacts.length === 1,
      "sync_state accept should have produced exactly one synced artifact.",
    );
    assert(
      currentStateAfterAllAccepts.data.currentRevision?.content?.includes("## 自动同步记录"),
      "current state artifact did not keep the auto sync block.",
    );
    assert(
      currentStateAfterAllAccepts.data.currentRevision?.content?.includes("最近回填文件：99_当前状态卡.md"),
      "current state artifact did not point at the last accepted artifact.",
    );
    assert(
      currentStateAfterAllAccepts.data.currentRevision?.content?.includes("来源任务：sync_state"),
      "current state artifact did not record the final task type.",
    );
    assert(
      currentStateAfterAllAccepts.data.currentRevision?.content?.includes("回填摘要：Smoke sync state accept revision"),
      "current state artifact did not record the final accept summary.",
    );

    const projectAfterAllAccepts = await fetchJson(
      `${baseUrl}/api/projects/${projectId}`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(projectAfterAllAccepts, "project after all accepts");
    const nextProjectUpdatedAt = Date.parse(projectAfterAllAccepts.data.updatedAt);
    assert(
      nextProjectUpdatedAt >= previousProjectUpdatedAt,
      "project updatedAt did not move forward after the final accept flow.",
    );
    assert(
      projectAfterAllAccepts.data.preference?.activeChapterArtifactId === chapterArtifact.id,
      "project preference lost the active chapter after the mainline flow.",
    );

    const finalChapterIndex = Array.isArray(projectAfterAllAccepts.data.preference?.chapterIndex)
      ? projectAfterAllAccepts.data.preference.chapterIndex
      : [];
    const finalChapterEntry = finalChapterIndex.find((item) => item.artifactId === chapterArtifact.id);
    assert(finalChapterEntry, "chapterIndex entry for the active chapter was not found.");
    assert(finalChapterEntry.status === "accepted", "chapterIndex entry did not end in accepted status.");
    assert(
      finalChapterEntry.latestDraftId === minimalFixDraft.id,
      "chapterIndex latestDraftId did not track the minimal_fix draft.",
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

    const finalRuns = [
      findItemById(runsAfterFlow.data.items, settingRun.id, "generate_setting final run"),
      findItemById(runsAfterFlow.data.items, outlineRun.id, "generate_outline final run"),
      findItemById(runsAfterFlow.data.items, researchRun.id, "research_fact_check final run"),
      findItemById(runsAfterFlow.data.items, chapterRun.id, "generate_chapter final run"),
      findItemById(runsAfterFlow.data.items, reviewRun.id, "review_content final run"),
      findItemById(runsAfterFlow.data.items, minimalFixRun.id, "minimal_fix final run"),
      findItemById(runsAfterFlow.data.items, syncStateRun.id, "sync_state final run"),
    ];

    for (const run of finalRuns) {
      assert(run.status === "succeeded", `expected run ${run.id} to succeed, got ${run.status}`);
    }

    const draftsAfterFlow = await fetchJson(
      `${baseUrl}/api/projects/${projectId}/drafts`,
      {
        method: "GET",
      },
      cookies,
    );
    assertOk(draftsAfterFlow, "drafts after full flow");

    const finalDrafts = [
      findItemById(draftsAfterFlow.data.items, settingDraft.id, "generate_setting final draft"),
      findItemById(draftsAfterFlow.data.items, outlineDraft.id, "generate_outline final draft"),
      findItemById(draftsAfterFlow.data.items, researchDraft.id, "research_fact_check final draft"),
      findItemById(draftsAfterFlow.data.items, chapterDraft.id, "generate_chapter final draft"),
      findItemById(draftsAfterFlow.data.items, reviewDraft.id, "review_content final draft"),
      findItemById(draftsAfterFlow.data.items, minimalFixDraft.id, "minimal_fix final draft"),
      findItemById(draftsAfterFlow.data.items, syncStateDraft.id, "sync_state final draft"),
    ];

    for (const draft of finalDrafts) {
      assert(draft.status === "accepted", `expected draft ${draft.id} to be accepted, got ${draft.status}`);
    }

    assert(reviewDraft.draftKind === "review_revision", "review_content draftKind was not review_revision.");
    assert(grokState.requests.length === 1, `expected exactly 1 GrokSearch request, got ${grokState.requests.length}`);
    assert(providerState.requests.length >= 8, `expected at least 8 provider requests, got ${providerState.requests.length}`);

    console.log(
      JSON.stringify({
        baseUrl,
        providerBaseUrl,
        grokBaseUrl,
        projectId,
        endpointId,
        referenceId: referenceItem.id,
        settingRunId: settingRun.id,
        outlineRunId: outlineRun.id,
        researchRunId: researchRun.id,
        chapterRunId: chapterRun.id,
        reviewRunId: reviewRun.id,
        minimalFixRunId: minimalFixRun.id,
        syncStateRunId: syncStateRun.id,
        findingsArtifactId: findingsArtifact.id,
        chapterArtifactId: chapterArtifact.id,
        progressArtifactId: progressArtifact.id,
        currentStateArtifactId: currentStateArtifact.id,
        providerRequestCount: providerState.requests.length,
        grokRequestCount: grokState.requests.length,
        finalProjectUpdatedAt: projectAfterAllAccepts.data.updatedAt,
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
