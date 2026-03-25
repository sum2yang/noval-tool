import { describe, expect, it } from "vitest";

import {
  buildOperatorErrorMessage,
  extractSourceDetailItems,
  getExternalSearchStatusLabel,
  getGrokConfigSourceLabel,
  getRunFailureHint,
  parseRunDiagnostics,
} from "./diagnostics";

describe("run diagnostics helpers", () => {
  it("parses mcp and external search summaries into author-facing diagnostics", () => {
    const diagnostics = parseRunDiagnostics({
      toolInventory: [
        {
          serverId: "mcp-1",
          serverName: "资料库",
          toolName: "lookup_fact",
          namespacedToolName: "ziliao__lookup_fact",
        },
      ],
      calls: [
        {
          step: 1,
          toolCallId: "call-1",
          toolName: "ziliao__lookup_fact",
        },
      ],
      externalSearch: {
        provider: "groksearch",
        configSource: "user",
        toolName: "web_search",
        status: "ok",
        attemptCount: 2,
        sourcesCount: 6,
        sessionId: "session-1234567890",
        contentPreview: "找到 6 条资料，可继续追溯来源。",
        payload: {
          query: "核查旧上海轮渡税率",
          taskType: "research_fact_check",
        },
      },
      externalPromptTemplate: {
        source: "mcp_prompt",
        serverName: "资料库",
        promptName: "research_pack",
        preview: "先查资料，再输出结论。",
      },
    });

    expect(diagnostics.mcp).toMatchObject({
      serverCount: 1,
      toolInventoryCount: 1,
      callCount: 1,
      calledTools: ["资料库 / lookup_fact"],
    });
    expect(diagnostics.externalSearch).toMatchObject({
      configSource: "user",
      status: "ok",
      sourcesCount: 6,
      query: "核查旧上海轮渡税率",
    });
    expect(diagnostics.externalPromptTemplate).toMatchObject({
      source: "mcp_prompt",
      serverName: "资料库",
      promptName: "research_pack",
    });
  });

  it("builds operator-friendly failure guidance", () => {
    expect(getExternalSearchStatusLabel("ok")).toBe("已完成");
    expect(getGrokConfigSourceLabel("mixed")).toBe("混合来源");
    expect(getGrokConfigSourceLabel("env")).toBe("平台默认");
    expect(getRunFailureHint("MCP tool loading failed.", null)).toContain("MCP");
    expect(getRunFailureHint("Failed after 3 attempts. Last error: Gateway Timeout", "TIMEOUT")).toContain("上游网关超时");
    expect(getRunFailureHint("The generation stream was aborted before completion.", "CANCELED")).toContain("流式生成在完成前被中断");
    expect(
      buildOperatorErrorMessage({
        error: {
          code: "AUTH_ERROR",
          message: "Invalid API key",
        },
      }),
    ).toContain("处理建议");
  });

  it("extracts source detail items from nested grok source payloads", () => {
    const items = extractSourceDetailItems({
      sources: [
        {
          title: "Harbor Report",
          url: "https://example.com/harbor",
          summary: "记录秋季船期变化。",
        },
        {
          source: {
            name: "Customs Bulletin",
            link: "https://example.com/customs",
            description: "记录税率调整。",
          },
        },
      ],
    });

    expect(items).toEqual([
      {
        title: "Harbor Report",
        url: "https://example.com/harbor",
        snippet: "记录秋季船期变化。",
      },
      {
        title: "Customs Bulletin",
        url: "https://example.com/customs",
        snippet: "记录税率调整。",
      },
    ]);
  });
});
