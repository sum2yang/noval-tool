function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function pickNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function previewText(value: string | null | undefined, limit = 180) {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

type ToolInventoryRow = {
  serverId: string | null;
  serverName: string | null;
  toolName: string | null;
  namespacedToolName: string | null;
};

type ToolCallRow = {
  step: number | null;
  toolCallId: string | null;
  toolName: string | null;
};

export type SourceDetailItem = {
  title: string | null;
  url: string | null;
  snippet: string | null;
};

export type ParsedRunDiagnostics = {
  mcp: null | {
    serverCount: number;
    serverNames: string[];
    toolInventoryCount: number;
    callCount: number;
    calledTools: string[];
  };
  externalSearch: null | {
    provider: string | null;
    status: string | null;
    toolName: string | null;
    configSource: string | null;
    attemptCount: number | null;
    query: string | null;
    taskType: string | null;
    sourcesCount: number | null;
    sessionId: string | null;
    contentPreview: string | null;
  };
  externalPromptTemplate: null | {
    source: string | null;
    serverName: string | null;
    promptName: string | null;
    preview: string | null;
  };
};

function parseToolInventory(value: unknown) {
  if (!Array.isArray(value)) {
    return [] satisfies ToolInventoryRow[];
  }

  return value
    .map((item): ToolInventoryRow | null => {
      if (!isRecord(item)) {
        return null;
      }

      return {
        serverId: pickText(item.serverId),
        serverName: pickText(item.serverName),
        toolName: pickText(item.toolName),
        namespacedToolName: pickText(item.namespacedToolName),
      };
    })
    .filter((item): item is ToolInventoryRow => Boolean(item));
}

function parseToolCalls(value: unknown) {
  if (!Array.isArray(value)) {
    return [] satisfies ToolCallRow[];
  }

  return value
    .map((item): ToolCallRow | null => {
      if (!isRecord(item)) {
        return null;
      }

      return {
        step: pickNumber(item.step),
        toolCallId: pickText(item.toolCallId),
        toolName: pickText(item.toolName),
      };
    })
    .filter((item): item is ToolCallRow => Boolean(item));
}

function toSourceDetailItem(value: Record<string, unknown>) {
  const title =
    pickText(value.title) ??
    pickText(value.name) ??
    pickText(value.headline) ??
    pickText(value.source) ??
    pickText(value.label);
  const url =
    pickText(value.url) ??
    pickText(value.link) ??
    pickText(value.href) ??
    pickText(value.sourceUrl);
  const snippet =
    pickText(value.snippet) ??
    pickText(value.summary) ??
    pickText(value.description) ??
    pickText(value.content) ??
    pickText(value.text);

  if (!title && !url && !snippet) {
    return null;
  }

  return { title, url, snippet };
}

function collectSourceDetailItems(value: unknown, depth = 0, seen = new Set<string>()): SourceDetailItem[] {
  if (depth > 4) {
    return [] satisfies SourceDetailItem[];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectSourceDetailItems(item, depth + 1, seen));
  }

  if (!isRecord(value)) {
    return [];
  }

  const items: SourceDetailItem[] = [];
  const item = toSourceDetailItem(value);

  if (item) {
    const key = `${item.title ?? ""}|${item.url ?? ""}|${item.snippet ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      items.push(item);
    }
  }

  for (const nestedValue of Object.values(value)) {
    items.push(...collectSourceDetailItems(nestedValue, depth + 1, seen));
  }

  return items;
}

function parseExternalSearch(value: unknown): ParsedRunDiagnostics["externalSearch"] {
  if (!isRecord(value)) {
    return null;
  }

  const payload = isRecord(value.payload) ? value.payload : null;

  return {
    provider: pickText(value.provider),
    status: pickText(value.status),
    toolName: pickText(value.toolName),
    configSource: pickText(value.configSource),
    attemptCount: pickNumber(value.attemptCount),
    query: pickText(payload?.query),
    taskType: pickText(payload?.taskType),
    sourcesCount: pickNumber(value.sourcesCount),
    sessionId: pickText(value.sessionId),
    contentPreview: previewText(pickText(value.contentPreview) ?? pickText(value.dataPreview), 220),
  };
}

function parseExternalPromptTemplate(value: unknown): ParsedRunDiagnostics["externalPromptTemplate"] {
  if (!isRecord(value)) {
    return null;
  }

  return {
    source: pickText(value.source),
    serverName: pickText(value.serverName),
    promptName: pickText(value.promptName),
    preview: previewText(pickText(value.preview), 180),
  };
}

export function parseRunDiagnostics(summary: unknown): ParsedRunDiagnostics {
  const record = isRecord(summary) ? summary : {};
  const toolInventory = parseToolInventory(record.toolInventory);
  const toolCalls = parseToolCalls(record.calls);
  const toolLookup = new Map(
    toolInventory
      .filter((row) => row.namespacedToolName)
      .map((row) => [
        row.namespacedToolName as string,
        {
          serverName: row.serverName,
          toolName: row.toolName,
        },
      ]),
  );

  const calledTools = uniqueStrings(
    toolCalls.map((call) => {
      if (!call.toolName) {
        return null;
      }

      const mapped = toolLookup.get(call.toolName);
      if (!mapped) {
        return call.toolName;
      }

      return [mapped.serverName, mapped.toolName].filter(Boolean).join(" / ");
    }),
  );
  const serverNames = uniqueStrings(toolInventory.map((row) => row.serverName));

  return {
    mcp:
      toolInventory.length > 0 || toolCalls.length > 0
        ? {
            serverCount: serverNames.length,
            serverNames,
            toolInventoryCount: toolInventory.length,
            callCount: toolCalls.length,
            calledTools,
          }
        : null,
    externalSearch: parseExternalSearch(record.externalSearch),
    externalPromptTemplate: parseExternalPromptTemplate(record.externalPromptTemplate),
  };
}

export function extractSourceDetailItems(value: unknown) {
  return collectSourceDetailItems(value).slice(0, 20);
}

export function getExternalSearchStatusLabel(status: string | null | undefined) {
  switch (status) {
    case "ok":
      return "已完成";
    case "AUTH_ERROR":
      return "鉴权失败";
    case "TIMEOUT":
      return "请求超时";
    case "NETWORK_ERROR":
      return "网络失败";
    case "SEARCH_UNAVAILABLE":
      return "搜索不可用";
    default:
      return "未记录";
  }
}

export function getGrokConfigSourceLabel(source: string | null | undefined) {
  switch (source) {
    case "user":
      return "个人配置";
    case "mixed":
      return "混合来源";
    case "env":
      return "平台默认";
    default:
      return "未记录";
  }
}

export function getPromptTemplateSourceLabel(source: string | null | undefined) {
  switch (source) {
    case "mcp_prompt":
      return "MCP 提示模板";
    default:
      return "外部模板";
  }
}

export function getRunFailureHint(errorSummary: string | null | undefined, errorCode?: string | null) {
  const code = errorCode?.trim().toUpperCase();
  const message = (errorSummary ?? "").trim();
  const normalized = message.toLowerCase();

  if (code === "SEARCH_UNAVAILABLE" || normalized.includes("groksearch")) {
    return "先检查个人 GrokSearch 配置，或确认平台默认回退是否可用。";
  }

  if (code === "MCP_UNAVAILABLE" || normalized.includes("mcp")) {
    return "先到设置页检查 MCP 服务健康状态，确认服务确实暴露了可用工具，或先取消本次 MCP 勾选再重试。";
  }

  if (code === "AUTH_ERROR" || normalized.includes("unauthorized") || normalized.includes("api key")) {
    return "先检查当前接口的密钥、鉴权方式和默认模型是否匹配。";
  }

  if (
    code === "TIMEOUT" ||
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("gateway timeout")
  ) {
    return "当前是上游网关超时。平台已适度放宽等待时间，但如果你使用的是第三方 OpenAI 兼容网关，且接口模式为 Responses API，建议先切到 Chat Completions API；同时减少 MCP / 外部事实 / 上下文体量，或检查上游代理超时配置后再重试。";
  }

  if (code === "CANCELED" || normalized.includes("aborted before completion") || normalized.includes("stream was aborted")) {
    return "当前是流式生成在完成前被中断。常见原因有 3 类：浏览器页面在生成中刷新/切页、反向代理读超时、或平台任务等待预算耗尽。如果你使用的是第三方 OpenAI 兼容网关，且接口模式为 Responses API，建议先切到 Chat Completions API；同时可减少上下文体量后再试。";
  }

  if (code === "MODEL_UNAVAILABLE" || normalized.includes("model")) {
    return "先在设置页执行模型接口健康检查，确认 baseURL、模型名和服务可达性。";
  }

  if (!message) {
    return null;
  }

  return "建议先看上方运行诊断，再检查本次模型接口、MCP 勾选和外部事实开关。";
}

export function buildOperatorErrorMessage(payload: unknown) {
  if (!isRecord(payload) || !isRecord(payload.error)) {
    return "请求失败。";
  }

  const errorMessage = pickText(payload.error.message) ?? "请求失败。";
  const errorCode = pickText(payload.error.code);
  const hint = getRunFailureHint(errorMessage, errorCode);

  return hint ? `${errorMessage}\n处理建议：${hint}` : errorMessage;
}
