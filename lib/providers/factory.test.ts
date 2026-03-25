import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const generateTextMock = vi.fn();
const openaiDefaultModelMock = vi.fn((modelId: string) => ({ provider: "openai-default", modelId }));
const openaiResponsesModelMock = vi.fn((modelId: string) => ({ provider: "openai-responses", modelId }));
const openaiChatModelMock = vi.fn((modelId: string) => ({ provider: "openai-chat", modelId }));
const createOpenAIMock = vi.fn(() =>
  Object.assign((modelId: string) => openaiDefaultModelMock(modelId), {
    chat: (modelId: string) => openaiChatModelMock(modelId),
    responses: (modelId: string) => openaiResponsesModelMock(modelId),
  }),
);
const createGoogleGenerativeAIMock = vi.fn(() => (modelId: string) => ({ provider: "gemini", modelId }));
const createAnthropicMock = vi.fn(() => (modelId: string) => ({ provider: "anthropic", modelId }));

vi.mock("ai", () => ({
  generateText: generateTextMock,
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: createOpenAIMock,
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: createGoogleGenerativeAIMock,
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: createAnthropicMock,
}));

const BASE_ENV = {
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/novel_tools?schema=public",
  BETTER_AUTH_SECRET: "test-secret",
  BETTER_AUTH_URL: "http://localhost:3000",
  APP_BASE_URL: "http://localhost:3000",
  APP_ENV: "test",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  GROK_API_URL: "",
  GROK_API_KEY: "",
  GROK_MODEL: "",
  TAVILY_API_URL: "",
  TAVILY_API_KEY: "",
  FIRECRAWL_API_URL: "",
  FIRECRAWL_API_KEY: "",
  GROK_RETRY_MAX_ATTEMPTS: "2",
  GROK_RETRY_MULTIPLIER: "2",
  GROK_RETRY_MAX_WAIT: "30000",
} as const;

describe("provider endpoint probe", () => {
  beforeEach(() => {
    vi.resetModules();
    generateTextMock.mockReset();
    openaiDefaultModelMock.mockClear();
    openaiResponsesModelMock.mockClear();
    openaiChatModelMock.mockClear();
    createOpenAIMock.mockClear();
    createGoogleGenerativeAIMock.mockClear();
    createAnthropicMock.mockClear();

    for (const [key, value] of Object.entries(BASE_ENV)) {
      vi.stubEnv(key, value);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses OpenAI responses API by default", async () => {
    const { encryptString } = await import("@/lib/security/crypto");
    const { createLanguageModel } = await import("./factory");

    const model = createLanguageModel(
      {
        id: "endpoint-responses",
        userId: "user-1",
        providerType: "openai",
        openaiApiStyle: "responses",
        label: "OpenAI Responses",
        baseURL: "https://api.example.com/v1",
        authMode: "bearer",
        encryptedSecret: encryptString("secret"),
        encryptedHeaders: {},
        defaultModel: "gpt-5",
        healthStatus: "misconfigured",
        lastHealthCheckAt: null,
        archivedAt: null,
        createdAt: new Date("2026-03-20T00:00:00.000Z"),
        updatedAt: new Date("2026-03-20T00:00:00.000Z"),
      },
      "gpt-5",
    );

    expect(createOpenAIMock).toHaveBeenCalledTimes(1);
    expect(openaiResponsesModelMock).toHaveBeenCalledWith("gpt-5");
    expect(openaiChatModelMock).not.toHaveBeenCalled();
    expect(model).toEqual({ provider: "openai-responses", modelId: "gpt-5" });
  });

  it("uses OpenAI chat completions when configured", async () => {
    const { encryptString } = await import("@/lib/security/crypto");
    const { createLanguageModel } = await import("./factory");

    const model = createLanguageModel(
      {
        id: "endpoint-chat",
        userId: "user-1",
        providerType: "openai",
        openaiApiStyle: "chat_completions",
        label: "OpenAI Chat",
        baseURL: "https://api.example.com/v1",
        authMode: "bearer",
        encryptedSecret: encryptString("secret"),
        encryptedHeaders: {},
        defaultModel: "gpt-4o",
        healthStatus: "misconfigured",
        lastHealthCheckAt: null,
        archivedAt: null,
        createdAt: new Date("2026-03-20T00:00:00.000Z"),
        updatedAt: new Date("2026-03-20T00:00:00.000Z"),
      },
      "gpt-4o",
    );

    expect(createOpenAIMock).toHaveBeenCalledTimes(1);
    expect(openaiChatModelMock).toHaveBeenCalledWith("gpt-4o");
    expect(openaiResponsesModelMock).not.toHaveBeenCalled();
    expect(model).toEqual({ provider: "openai-chat", modelId: "gpt-4o" });
  });

  it("marks the endpoint healthy after a successful minimal probe", async () => {
    generateTextMock.mockResolvedValue({
      text: "OK",
    });

    const { encryptString } = await import("@/lib/security/crypto");
    const { probeEndpoint } = await import("./factory");

    const result = await probeEndpoint({
      id: "endpoint-1",
      userId: "user-1",
      providerType: "openai",
      openaiApiStyle: "responses",
      label: "OpenAI Mock",
      baseURL: "https://api.example.com/v1",
      authMode: "bearer",
      encryptedSecret: encryptString("test-secret"),
      encryptedHeaders: {},
      defaultModel: "gpt-test",
      healthStatus: "misconfigured",
      lastHealthCheckAt: null,
      archivedAt: null,
      createdAt: new Date("2026-03-20T00:00:00.000Z"),
      updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    });

    expect(result.status).toBe("healthy");
    expect(result.note).toContain('Minimal model probe succeeded for "gpt-test"');
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Reply with exactly OK.",
        maxOutputTokens: 8,
        temperature: 0,
        maxRetries: 0,
      }),
    );
  });

  it("marks authentication failures as invalid_auth", async () => {
    generateTextMock.mockRejectedValue(new Error("401 Unauthorized: invalid API key"));

    const { encryptString } = await import("@/lib/security/crypto");
    const { probeEndpoint } = await import("./factory");

    const result = await probeEndpoint({
      id: "endpoint-2",
      userId: "user-1",
      providerType: "anthropic",
      openaiApiStyle: "responses",
      label: "Anthropic Mock",
      baseURL: "https://api.example.com",
      authMode: "bearer",
      encryptedSecret: encryptString("bad-secret"),
      encryptedHeaders: {},
      defaultModel: "claude-test",
      healthStatus: "misconfigured",
      lastHealthCheckAt: null,
      archivedAt: null,
      createdAt: new Date("2026-03-20T00:00:00.000Z"),
      updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    });

    expect(result.status).toBe("invalid_auth");
    expect(result.note).toContain("invalid API key");
  });

  it("marks transport failures as unreachable", async () => {
    generateTextMock.mockRejectedValue(new Error("fetch failed: connect ECONNREFUSED"));

    const { encryptString } = await import("@/lib/security/crypto");
    const { probeEndpoint } = await import("./factory");

    const result = await probeEndpoint({
      id: "endpoint-3",
      userId: "user-1",
      providerType: "gemini",
      openaiApiStyle: "responses",
      label: "Gemini Mock",
      baseURL: "https://api.example.com",
      authMode: "bearer",
      encryptedSecret: encryptString("secret"),
      encryptedHeaders: {},
      defaultModel: "gemini-test",
      healthStatus: "misconfigured",
      lastHealthCheckAt: null,
      archivedAt: null,
      createdAt: new Date("2026-03-20T00:00:00.000Z"),
      updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    });

    expect(result.status).toBe("unreachable");
    expect(result.note).toContain("ECONNREFUSED");
  });

  it("marks missing models or bad requests as misconfigured", async () => {
    generateTextMock.mockRejectedValue(new Error("404 model not found"));

    const { encryptString } = await import("@/lib/security/crypto");
    const { probeEndpoint } = await import("./factory");

    const result = await probeEndpoint({
      id: "endpoint-4",
      userId: "user-1",
      providerType: "openai",
      openaiApiStyle: "responses",
      label: "OpenAI Mock",
      baseURL: "https://api.example.com/v1",
      authMode: "bearer",
      encryptedSecret: encryptString("secret"),
      encryptedHeaders: {},
      defaultModel: "missing-model",
      healthStatus: "misconfigured",
      lastHealthCheckAt: null,
      archivedAt: null,
      createdAt: new Date("2026-03-20T00:00:00.000Z"),
      updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    });

    expect(result.status).toBe("misconfigured");
    expect(result.note).toContain("404 model not found");
  });
});
