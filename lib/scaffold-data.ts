import "server-only";

import { prisma } from "@/lib/db";
import { buildGenerationArchiveDownloadPath } from "@/lib/generation/archive";
import { loadKnowledgeBase } from "@/lib/knowledge";
import {
  normalizeChapterIndex,
  normalizeEditorLayoutPrefs,
  resolveActiveChapterArtifactId,
} from "@/lib/projects/editor-state";

export async function getHomeSnapshot() {
  const knowledge = await loadKnowledgeBase();

  return {
    canonicalCount: Object.keys(knowledge.canonical).length,
    promptCount: Object.keys(knowledge.prompts).length,
    skillCount: Object.keys(knowledge.skills).length,
    schemaCount: Object.keys(knowledge.schemas).length,
  };
}

export async function getProjectSnapshots(userId: string) {
  try {
    return await prisma.project.findMany({
      where: {
        userId,
      },
      orderBy: { updatedAt: "desc" },
      include: {
        preference: true,
        _count: {
          select: {
            artifacts: true,
            drafts: true,
            references: true,
          },
        },
      },
      take: 8,
    });
  } catch {
    return [];
  }
}

export async function getWorkbenchSnapshot(projectId: string, userId: string) {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        preference: true,
        artifacts: {
          include: {
            currentRevision: true,
            revisions: {
              orderBy: { createdAt: "desc" },
              take: 5,
            },
          },
          orderBy: [{ kind: "asc" }, { filename: "asc" }],
        },
        references: {
          orderBy: { createdAt: "desc" },
          take: 6,
        },
      },
    });

    if (project?.userId === userId) {
      const chapterIndex = normalizeChapterIndex(project.preference?.chapterIndex);
      const editorLayoutPrefs = normalizeEditorLayoutPrefs(project.preference?.editorLayoutPrefs);
      const activeChapterArtifactId = resolveActiveChapterArtifactId(
        project.preference?.activeChapterArtifactId,
        chapterIndex,
        project.artifacts.filter((artifact) => artifact.kind === "project_chapter").map((artifact) => artifact.id),
      );
      const [providerEndpoints, mcpServers, drafts, editorAutosaveDraft, runs] = await Promise.all([
        prisma.providerEndpoint.findMany({
          where: {
            userId,
            archivedAt: null,
          },
          orderBy: [{ updatedAt: "desc" }],
          select: {
            id: true,
            providerType: true,
            label: true,
            baseURL: true,
            authMode: true,
            defaultModel: true,
            healthStatus: true,
            lastHealthCheckAt: true,
            updatedAt: true,
          },
        }),
        prisma.mcpServer.findMany({
          where: { userId },
          orderBy: [{ updatedAt: "desc" }],
          select: {
            id: true,
            name: true,
            transportType: true,
            serverUrl: true,
            authMode: true,
            toolCount: true,
            resourceCount: true,
            promptCount: true,
            healthStatus: true,
            lastSyncAt: true,
            updatedAt: true,
          },
        }),
        prisma.draft.findMany({
          where: {
            projectId,
            draftKind: {
              not: "editor_autosave",
            },
          },
          include: {
            run: {
              select: {
                id: true,
                resolvedContextArtifacts: true,
              },
            },
          },
          orderBy: { updatedAt: "desc" },
          take: 12,
        }),
        prisma.draft.findFirst({
          where: {
            projectId,
            draftKind: "editor_autosave",
            ...(activeChapterArtifactId ? { artifactId: activeChapterArtifactId } : {}),
          },
          orderBy: { updatedAt: "desc" },
        }),
        prisma.generationRun.findMany({
          where: {
            projectId,
            project: {
              userId,
            },
          },
          orderBy: { createdAt: "desc" },
          take: 12,
          select: {
            id: true,
            taskType: true,
            modelId: true,
            status: true,
            errorSummary: true,
            toolCallsSummary: true,
            archiveStorageKey: true,
            archiveObjectStoreMode: true,
            archiveByteSize: true,
            archiveContentType: true,
            createdAt: true,
            endpoint: {
              select: {
                label: true,
                providerType: true,
              },
            },
            drafts: {
              orderBy: { updatedAt: "desc" },
              take: 3,
              select: {
                id: true,
                status: true,
              },
            },
          },
        }),
      ]);
      const serializedRuns = runs.map(({ archiveStorageKey, archiveObjectStoreMode, archiveByteSize, archiveContentType, ...run }) => ({
        ...run,
        hasArchive: Boolean(archiveStorageKey),
        archiveObjectStoreMode: archiveStorageKey ? archiveObjectStoreMode ?? null : null,
        archiveByteSize: archiveStorageKey ? archiveByteSize ?? null : null,
        archiveContentType: archiveStorageKey ? archiveContentType ?? null : null,
        archiveDownloadUrl: archiveStorageKey ? buildGenerationArchiveDownloadPath(projectId, run.id) : null,
      }));

      return {
        ...project,
        chapterIndex,
        editorLayoutPrefs,
        activeChapterArtifactId,
        drafts,
        editorAutosaveDraft,
        providerEndpoints,
        mcpServers,
        runs: serializedRuns,
      };
    }
  } catch {
    return null;
  }

  return null;
}
