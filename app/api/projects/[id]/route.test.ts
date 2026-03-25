import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
  project: {
    findFirst: vi.fn(),
    delete: vi.fn(),
  },
  providerEndpoint: {
    findFirst: vi.fn(),
  },
  workspaceArtifact: {
    findFirst: vi.fn(),
  },
  projectPreference: {
    upsert: vi.fn(),
  },
};

const resolveRequestUserMock = vi.fn();
const deleteObjectMock = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: prismaMock,
}));

vi.mock("@/lib/auth/identity", () => ({
  resolveRequestUser: resolveRequestUserMock,
}));

vi.mock("@/lib/storage/object-store", () => ({
  deleteObject: deleteObjectMock,
}));

describe("project route", () => {
  beforeEach(() => {
    vi.resetModules();
    prismaMock.project.findFirst.mockReset();
    prismaMock.project.delete.mockReset();
    prismaMock.providerEndpoint.findFirst.mockReset();
    prismaMock.workspaceArtifact.findFirst.mockReset();
    prismaMock.projectPreference.upsert.mockReset();
    resolveRequestUserMock.mockReset();
    deleteObjectMock.mockReset();

    resolveRequestUserMock.mockResolvedValue({ id: "user-1" });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("updates project preference presets as an ordered custom list through PATCH /api/projects/:id", async () => {
    prismaMock.project.findFirst.mockResolvedValue({ id: "project-1" });
    prismaMock.providerEndpoint.findFirst.mockResolvedValue({ id: "endpoint-1" });
    prismaMock.workspaceArtifact.findFirst.mockResolvedValue({ id: "chapter-artifact-1" });
    prismaMock.projectPreference.upsert.mockResolvedValue({
      id: "pref-1",
      projectId: "project-1",
      defaultEndpointId: "endpoint-1",
      defaultModel: "gpt-5",
      defaultTaskType: "generate_chapter",
      apiPresets: [
        {
          presetKey: "chapter-fast",
          label: "章节快写",
          endpointId: "endpoint-1",
          modelId: "gpt-5",
          taskType: "generate_chapter",
          temperature: 0.7,
          maxTokens: 1400,
        },
        {
          presetKey: "deep-review",
          label: "深度审稿",
          endpointId: null,
          modelId: "gpt-5-mini",
          taskType: "review_content",
          temperature: 0.3,
          maxTokens: 1200,
        },
      ],
      activeChapterArtifactId: "chapter-artifact-1",
      ledgerEnabled: false,
      showSelfCheck: true,
      showSettlement: true,
    });

    const { PATCH } = await import("./route");

    const response = await PATCH(
      new Request("http://localhost/api/projects/project-1", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          defaultEndpointId: "endpoint-1",
          defaultModel: "gpt-5",
          defaultTaskType: "generate_chapter",
          activeChapterArtifactId: "chapter-artifact-1",
          apiPresets: [
            {
              presetKey: "chapter-fast",
              label: "章节快写",
              endpointId: "endpoint-1",
              modelId: "gpt-5",
              taskType: "generate_chapter",
              temperature: 0.7,
              maxTokens: 1400,
            },
            {
              presetKey: "deep-review",
              label: "深度审稿",
              endpointId: null,
              modelId: "gpt-5-mini",
              taskType: "review_content",
              temperature: 0.3,
              maxTokens: 1200,
            },
          ],
        }),
      }),
      {
        params: Promise.resolve({ id: "project-1" }),
      },
    );

    expect(response.status).toBe(200);
    expect(prismaMock.project.findFirst).toHaveBeenCalledWith({
      where: {
        id: "project-1",
        userId: "user-1",
      },
      select: {
        id: true,
      },
    });
    expect(prismaMock.providerEndpoint.findFirst).toHaveBeenCalledWith({
      where: {
        id: "endpoint-1",
        userId: "user-1",
        archivedAt: null,
      },
      select: { id: true },
    });
    expect(prismaMock.workspaceArtifact.findFirst).toHaveBeenCalledWith({
      where: {
        id: "chapter-artifact-1",
        projectId: "project-1",
        kind: "project_chapter",
      },
      select: { id: true },
    });
    expect(prismaMock.projectPreference.upsert).toHaveBeenCalledWith({
      where: {
        projectId: "project-1",
      },
      update: {
        defaultEndpointId: "endpoint-1",
        defaultModel: "gpt-5",
        defaultTaskType: "generate_chapter",
        activeChapterArtifactId: "chapter-artifact-1",
        apiPresets: [
          {
            presetKey: "chapter-fast",
            label: "章节快写",
            endpointId: "endpoint-1",
            modelId: "gpt-5",
            taskType: "generate_chapter",
            temperature: 0.7,
            maxTokens: 1400,
          },
          {
            presetKey: "deep-review",
            label: "深度审稿",
            endpointId: null,
            modelId: "gpt-5-mini",
            taskType: "review_content",
            temperature: 0.3,
            maxTokens: 1200,
          },
        ],
      },
      create: {
        projectId: "project-1",
        defaultEndpointId: "endpoint-1",
        defaultModel: "gpt-5",
        defaultTaskType: "generate_chapter",
        ledgerEnabled: false,
        showSelfCheck: true,
        showSettlement: true,
        activeChapterArtifactId: "chapter-artifact-1",
        apiPresets: [
          {
            presetKey: "chapter-fast",
            label: "章节快写",
            endpointId: "endpoint-1",
            modelId: "gpt-5",
            taskType: "generate_chapter",
            temperature: 0.7,
            maxTokens: 1400,
          },
          {
            presetKey: "deep-review",
            label: "深度审稿",
            endpointId: null,
            modelId: "gpt-5-mini",
            taskType: "review_content",
            temperature: 0.3,
            maxTokens: 1200,
          },
        ],
        chapterIndex: [],
        editorLayoutPrefs: {
          fontSize: "medium",
          lineHeight: "relaxed",
          contentWidth: "medium",
          focusMode: false,
          showLineNumbers: false,
          showIndentGuides: true,
          autosaveEnabled: true,
          autosaveIntervalMs: 5000,
          visualPreset: "qidian_tomato_minimal",
          editorTheme: "warm_light",
        },
      },
    });

    const body = await response.json();
    expect(body).toMatchObject({
      preference: {
        id: "pref-1",
        defaultEndpointId: "endpoint-1",
        defaultModel: "gpt-5",
        apiPresets: [
          {
            presetKey: "chapter-fast",
            label: "章节快写",
            endpointId: "endpoint-1",
            modelId: "gpt-5",
            taskType: "generate_chapter",
            temperature: 0.7,
            maxTokens: 1400,
          },
          {
            presetKey: "deep-review",
            label: "深度审稿",
            endpointId: null,
            modelId: "gpt-5-mini",
            taskType: "review_content",
            temperature: 0.3,
            maxTokens: 1200,
          },
        ],
        activeChapterArtifactId: "chapter-artifact-1",
      },
    });
  });

  it("deletes a project and cleans related object-store files through DELETE /api/projects/:id", async () => {
    prismaMock.project.findFirst.mockResolvedValue({
      id: "project-1",
      references: [
        { storageKey: "projects/project-1/references/source-a.md" },
        { storageKey: null },
      ],
      runs: [
        { archiveStorageKey: "projects/project-1/runs/run-1/archive.json" },
        { archiveStorageKey: null },
      ],
      preference: {
        exportRecords: [
          {
            id: "export-1",
            bundleKey: "chapters",
            title: "章节导出",
            fileName: "chapters.md",
            storageKey: "projects/project-1/exports/export-1/chapters.md",
            contentType: "text/markdown; charset=utf-8",
            byteSize: 120,
            fileCount: 1,
            files: ["chapters.md"],
            sourceArtifactKeys: ["chapter_001"],
            exportedAt: "2026-03-22T10:00:00.000Z",
            objectStoreMode: "local",
          },
        ],
      },
    });
    prismaMock.project.delete.mockResolvedValue({ id: "project-1" });

    const { DELETE } = await import("./route");

    const response = await DELETE(new Request("http://localhost/api/projects/project-1", { method: "DELETE" }), {
      params: Promise.resolve({ id: "project-1" }),
    });

    expect(response.status).toBe(200);
    expect(prismaMock.project.findFirst).toHaveBeenCalledWith({
      where: {
        id: "project-1",
        userId: "user-1",
      },
      select: {
        id: true,
        references: {
          select: {
            storageKey: true,
          },
        },
        runs: {
          select: {
            archiveStorageKey: true,
          },
        },
        preference: {
          select: {
            exportRecords: true,
          },
        },
      },
    });
    expect(prismaMock.project.delete).toHaveBeenCalledWith({
      where: {
        id: "project-1",
      },
    });
    expect(deleteObjectMock).toHaveBeenCalledTimes(3);
    expect(deleteObjectMock).toHaveBeenCalledWith("projects/project-1/references/source-a.md");
    expect(deleteObjectMock).toHaveBeenCalledWith("projects/project-1/runs/run-1/archive.json");
    expect(deleteObjectMock).toHaveBeenCalledWith("projects/project-1/exports/export-1/chapters.md");

    const body = await response.json();
    expect(body).toMatchObject({
      deletedProjectId: "project-1",
      deletedObjectCount: 3,
    });
  });
});
