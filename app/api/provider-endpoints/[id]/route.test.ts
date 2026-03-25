import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
  providerEndpoint: {
    findFirst: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  generationRun: {
    findFirst: vi.fn(),
  },
  projectPreference: {
    findMany: vi.fn(),
    update: vi.fn(),
  },
};

const resolveRequestUserMock = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: prismaMock,
}));

vi.mock("@/lib/auth/identity", () => ({
  resolveRequestUser: resolveRequestUserMock,
}));

describe("provider endpoint delete route", () => {
  beforeEach(() => {
    vi.resetModules();
    prismaMock.providerEndpoint.findFirst.mockReset();
    prismaMock.providerEndpoint.update.mockReset();
    prismaMock.providerEndpoint.delete.mockReset();
    prismaMock.generationRun.findFirst.mockReset();
    prismaMock.projectPreference.findMany.mockReset();
    prismaMock.projectPreference.update.mockReset();
    resolveRequestUserMock.mockReset();
    resolveRequestUserMock.mockResolvedValue({ id: "user-1" });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("deletes an unused provider endpoint", async () => {
    prismaMock.providerEndpoint.findFirst.mockResolvedValue({
      id: "endpoint-1",
      label: "OpenAI Prod",
    });
    prismaMock.generationRun.findFirst.mockResolvedValue(null);
    prismaMock.projectPreference.findMany.mockResolvedValue([]);
    prismaMock.providerEndpoint.delete.mockResolvedValue({
      id: "endpoint-1",
    });

    const { DELETE } = await import("./route");

    const response = await DELETE(new Request("http://localhost/api/provider-endpoints/endpoint-1", { method: "DELETE" }), {
      params: Promise.resolve({ id: "endpoint-1" }),
    });

    expect(response.status).toBe(200);
    expect(prismaMock.providerEndpoint.delete).toHaveBeenCalledWith({
      where: { id: "endpoint-1" },
    });
    expect(prismaMock.providerEndpoint.update).not.toHaveBeenCalled();
  });

  it("archives a referenced endpoint and clears project preferences", async () => {
    prismaMock.providerEndpoint.findFirst.mockResolvedValue({
      id: "endpoint-1",
      label: "OpenAI Prod",
    });
    prismaMock.generationRun.findFirst.mockResolvedValue({
      id: "run-1",
    });
    prismaMock.projectPreference.findMany.mockResolvedValue([
      {
        id: "pref-1",
        defaultEndpointId: "endpoint-1",
        apiPresets: [
          {
            presetKey: "writing",
            label: "写作",
            endpointId: "endpoint-1",
            modelId: "gpt-5.4",
            taskType: "generate_chapter",
            temperature: 0.7,
            maxTokens: 1400,
          },
        ],
      },
    ]);
    prismaMock.projectPreference.update.mockResolvedValue({
      id: "pref-1",
    });
    prismaMock.providerEndpoint.update.mockResolvedValue({
      id: "endpoint-1",
      archivedAt: new Date("2026-03-25T01:30:00.000Z"),
    });

    const { DELETE } = await import("./route");

    const response = await DELETE(new Request("http://localhost/api/provider-endpoints/endpoint-1", { method: "DELETE" }), {
      params: Promise.resolve({ id: "endpoint-1" }),
    });

    expect(response.status).toBe(200);
    expect(prismaMock.providerEndpoint.delete).not.toHaveBeenCalled();
    expect(prismaMock.projectPreference.update).toHaveBeenCalledWith({
      where: {
        id: "pref-1",
      },
      data: {
        defaultEndpointId: null,
        apiPresets: [
          {
            presetKey: "writing",
            label: "写作",
            endpointId: null,
            modelId: "gpt-5.4",
            taskType: "generate_chapter",
            temperature: 0.7,
            maxTokens: 1400,
          },
        ],
      },
    });
    expect(prismaMock.providerEndpoint.update).toHaveBeenCalledWith({
      where: { id: "endpoint-1" },
      data: {
        archivedAt: expect.any(Date),
      },
    });
  });
});
