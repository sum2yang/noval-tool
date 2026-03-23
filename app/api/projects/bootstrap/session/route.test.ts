import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
  projectOnboardingSession: {
    create: vi.fn(),
  },
  providerEndpoint: {
    findFirst: vi.fn(),
  },
};

const resolveRequestUserMock = vi.fn();
const planAiOnboardingQuestionMock = vi.fn();
const planAiOnboardingQuestionStreamMock = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: prismaMock,
}));

vi.mock("@/lib/auth/identity", () => ({
  resolveRequestUser: resolveRequestUserMock,
}));

vi.mock("@/lib/projects/onboarding-ai", () => ({
  planAiOnboardingQuestion: planAiOnboardingQuestionMock,
  planAiOnboardingQuestionStream: planAiOnboardingQuestionStreamMock,
}));

vi.mock("@/lib/generation/execute", () => ({
  normalizeGenerationError: (error: unknown) => error,
  shouldUseStreamingGeneration: (endpoint: { providerType?: string; openaiApiStyle?: string | null }) =>
    endpoint.providerType === "openai" && endpoint.openaiApiStyle === "responses",
}));

function createTextStream(chunks: string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

async function readNdjson(response: Response) {
  const text = await response.text();
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("project onboarding create route", () => {
  beforeEach(() => {
    vi.resetModules();
    prismaMock.projectOnboardingSession.create.mockReset();
    prismaMock.providerEndpoint.findFirst.mockReset();
    resolveRequestUserMock.mockReset();
    planAiOnboardingQuestionMock.mockReset();
    planAiOnboardingQuestionStreamMock.mockReset();
    resolveRequestUserMock.mockResolvedValue({ id: "user-1" });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("creates a seeded onboarding session from the author's initial topic input", async () => {
    prismaMock.projectOnboardingSession.create.mockImplementation(async ({ data }) => ({
      id: "session-1",
      userId: "user-1",
      status: "active",
      currentQuestionIndex: 0,
      answers: data.answers,
      summary: data.summary,
      finalizedProjectId: null,
      completedAt: null,
      createdAt: new Date("2026-03-22T10:00:00.000Z"),
      updatedAt: new Date("2026-03-22T10:00:00.000Z"),
    }));

    const { POST } = await import("./route");

    const response = await POST(
      new Request("http://localhost/api/projects/bootstrap/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "港综资本局",
          genre: "港综商战",
          platform: "番茄",
          lengthHint: "180 万字长篇",
          era: "90 年代港岛",
          keywords: "资本局、上位、势力经营",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(prismaMock.projectOnboardingSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        status: "active",
        currentQuestionIndex: 0,
        answers: [
          expect.objectContaining({
            questionKey: "project_basics",
            answer: expect.stringContaining("题材是港综商战"),
            skipped: false,
          }),
        ],
      }),
    });

    const body = await response.json();
    expect(body.session.currentQuestion).toMatchObject({
      key: "project_basics",
      answer: expect.stringContaining("90 年代港岛"),
    });
    expect(body.session.currentQuestion.recommendedOptions).toHaveLength(3);
    expect(body.session.summary.metadata).toMatchObject({
      nameHint: "港综资本局",
      genreHint: "港综",
      platformHint: "番茄",
      lengthHint: "长篇",
    });
  });

  it("creates an AI dynamic onboarding session when endpoint info is provided", async () => {
    prismaMock.providerEndpoint.findFirst.mockResolvedValue({
      id: "endpoint-1",
      userId: "user-1",
      providerType: "openai",
      label: "Mock Endpoint",
      baseURL: "https://api.example.com/v1",
      authMode: "none",
      encryptedSecret: "",
      encryptedHeaders: {},
      defaultModel: "gpt-4o-mini",
      openaiApiStyle: "chat_completions",
      healthStatus: "healthy",
      lastHealthCheckAt: null,
      createdAt: new Date("2026-03-22T10:00:00.000Z"),
      updatedAt: new Date("2026-03-22T10:00:00.000Z"),
    });
    planAiOnboardingQuestionMock.mockResolvedValue({
      key: "core_conflict",
      title: "主角先要赢哪一局",
      prompt: "基于这个题材，主角眼下最需要赢下的第一场局是什么？",
      placeholder: "例如：先拿下某场谈判或翻盘机会。",
      optional: false,
      recommendedOptions: [
        {
          label: "先赢第一局",
          value: "主角眼下最重要的是先赢下一场能够证明自己价值的小局。",
        },
      ],
      askedAt: "2026-03-22T10:00:00.000Z",
      source: "ai",
    });
    prismaMock.projectOnboardingSession.create.mockImplementation(async ({ data }) => ({
      id: "session-ai",
      userId: "user-1",
      status: data.status,
      currentQuestionIndex: data.currentQuestionIndex,
      answers: data.answers,
      summary: data.summary,
      finalizedProjectId: null,
      completedAt: null,
      createdAt: new Date("2026-03-22T10:00:00.000Z"),
      updatedAt: new Date("2026-03-22T10:00:00.000Z"),
    }));

    const { POST } = await import("./route");

    const response = await POST(
      new Request("http://localhost/api/projects/bootstrap/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/x-ndjson",
        },
        body: JSON.stringify({
          genre: "港综商战",
          platform: "番茄",
          endpointId: "endpoint-1",
          modelId: "gpt-4o-mini",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(prismaMock.providerEndpoint.findFirst).toHaveBeenCalledWith({
      where: {
        id: "endpoint-1",
        userId: "user-1",
      },
    });
    expect(planAiOnboardingQuestionMock).toHaveBeenCalled();

    const body = await response.json();
    expect(body.session.mode).toBe("ai_dynamic");
    expect(body.session.runtime).toMatchObject({
      endpointId: "endpoint-1",
      endpointLabel: "Mock Endpoint",
      modelId: "gpt-4o-mini",
    });
    expect(body.session.currentQuestion).toMatchObject({
      key: "core_conflict",
      source: "ai",
      title: "主角先要赢哪一局",
    });
  });

  it("streams the first AI onboarding question when using OpenAI Responses API", async () => {
    prismaMock.providerEndpoint.findFirst.mockResolvedValue({
      id: "endpoint-stream",
      userId: "user-1",
      providerType: "openai",
      label: "Streaming Endpoint",
      baseURL: "https://api.example.com/v1",
      authMode: "none",
      encryptedSecret: "",
      encryptedHeaders: {},
      defaultModel: "gpt-4.1-mini",
      openaiApiStyle: "responses",
      healthStatus: "healthy",
      lastHealthCheckAt: null,
      createdAt: new Date("2026-03-22T10:00:00.000Z"),
      updatedAt: new Date("2026-03-22T10:00:00.000Z"),
    });
    planAiOnboardingQuestionStreamMock.mockResolvedValue({
      textStream: createTextStream(['{"questionKey":"core_conflict"', ',"prompt":"主角第一局要赢什么？"}']),
      completed: Promise.resolve({
        key: "core_conflict",
        title: "主角先要赢哪一局",
        prompt: "主角第一局必须赢下什么，才能让局面真正动起来？",
        placeholder: "例如：先拿下一场决定能否上桌的关键谈判。",
        optional: false,
        recommendedOptions: [
          {
            label: "先赢上桌资格",
            value: "主角必须先赢下一场足以证明自己配得上入局的关键谈判。",
          },
        ],
        askedAt: "2026-03-22T10:00:00.000Z",
        source: "ai",
      }),
    });
    prismaMock.projectOnboardingSession.create.mockImplementation(async ({ data }) => ({
      id: "session-stream",
      userId: "user-1",
      status: data.status,
      currentQuestionIndex: data.currentQuestionIndex,
      answers: data.answers,
      summary: data.summary,
      finalizedProjectId: null,
      completedAt: null,
      createdAt: new Date("2026-03-22T10:00:00.000Z"),
      updatedAt: new Date("2026-03-22T10:00:00.000Z"),
    }));

    const { POST } = await import("./route");

    const response = await POST(
      new Request("http://localhost/api/projects/bootstrap/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/x-ndjson",
        },
        body: JSON.stringify({
          genre: "港综商战",
          platform: "番茄",
          endpointId: "endpoint-stream",
          modelId: "gpt-4.1-mini",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(planAiOnboardingQuestionStreamMock).toHaveBeenCalled();

    const events = await readNdjson(response);
    expect(events.map((event) => event.type)).toEqual(["started", "text-delta", "text-delta", "completed"]);
    expect(events.at(-1)?.payload).toMatchObject({
      session: {
        id: "session-stream",
        mode: "ai_dynamic",
        currentQuestion: {
          key: "core_conflict",
          source: "ai",
          title: "主角先要赢哪一局",
        },
      },
    });
  });
});
