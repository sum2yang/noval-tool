import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
  providerEndpoint: {
    create: vi.fn(),
    findMany: vi.fn(),
  },
};

const resolveRequestUserMock = vi.fn();
const encryptStringMock = vi.fn((value: string) => `enc:${value}`);
const encryptRecordMock = vi.fn((value: Record<string, string>) => value);
const assertSafeRemoteUrlMock = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: prismaMock,
}));

vi.mock("@/lib/auth/identity", () => ({
  resolveRequestUser: resolveRequestUserMock,
}));

vi.mock("@/lib/security/crypto", () => ({
  encryptString: encryptStringMock,
  encryptRecord: encryptRecordMock,
}));

vi.mock("@/lib/security/url", () => ({
  assertSafeRemoteUrl: assertSafeRemoteUrlMock,
}));

describe("provider endpoint collection route", () => {
  beforeEach(() => {
    vi.resetModules();
    prismaMock.providerEndpoint.create.mockReset();
    prismaMock.providerEndpoint.findMany.mockReset();
    resolveRequestUserMock.mockReset();
    encryptStringMock.mockClear();
    encryptRecordMock.mockClear();
    assertSafeRemoteUrlMock.mockClear();
    resolveRequestUserMock.mockResolvedValue({ id: "user-1" });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("lists OpenAI API style in endpoint summaries", async () => {
    prismaMock.providerEndpoint.findMany.mockResolvedValue([
      {
        id: "endpoint-1",
        providerType: "openai",
        openaiApiStyle: "chat_completions",
        label: "OpenAI Chat",
        baseURL: "https://api.example.com/v1",
        authMode: "bearer",
        defaultModel: "gpt-4o",
        healthStatus: "healthy",
        lastHealthCheckAt: null,
        createdAt: new Date("2026-03-23T00:00:00.000Z"),
        updatedAt: new Date("2026-03-23T00:00:00.000Z"),
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/provider-endpoints"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(prismaMock.providerEndpoint.findMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        archivedAt: null,
      },
      orderBy: { updatedAt: "desc" },
      select: expect.objectContaining({
        openaiApiStyle: true,
      }),
    });
    expect(payload.items[0].openaiApiStyle).toBe("chat_completions");
  });

  it("persists chat completions mode for OpenAI endpoints", async () => {
    prismaMock.providerEndpoint.create.mockResolvedValue({
      id: "endpoint-1",
      providerType: "openai",
      openaiApiStyle: "chat_completions",
      label: "OpenAI Chat",
      baseURL: "https://api.example.com/v1",
      authMode: "bearer",
      defaultModel: "gpt-4o",
      healthStatus: "misconfigured",
      createdAt: new Date("2026-03-23T00:00:00.000Z"),
      updatedAt: new Date("2026-03-23T00:00:00.000Z"),
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/provider-endpoints", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          providerType: "openai",
          openaiApiStyle: "chat_completions",
          label: "OpenAI Chat",
          baseURL: "https://api.example.com/v1",
          authMode: "bearer",
          secret: "test-secret",
          extraHeaders: {
            "x-tenant": "novel",
          },
          defaultModel: "gpt-4o",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(assertSafeRemoteUrlMock).toHaveBeenCalledWith("https://api.example.com/v1");
    expect(prismaMock.providerEndpoint.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        providerType: "openai",
        openaiApiStyle: "chat_completions",
        encryptedSecret: "enc:test-secret",
        encryptedHeaders: {
          "x-tenant": "novel",
        },
      }),
      select: expect.objectContaining({
        openaiApiStyle: true,
      }),
    });
  });
});
