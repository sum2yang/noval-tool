import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { jsonError, jsonOk, parseJson } from "@/lib/api/http";
import { projectPreferenceUpdateSchema } from "@/lib/api/schemas";
import { resolveRequestUser } from "@/lib/auth/identity";
import { normalizeApiPresets } from "@/lib/projects/api-presets";
import { normalizeProjectExportRecords } from "@/lib/projects/export-bundles";
import { buildDefaultEditorLayoutPrefs } from "@/lib/projects/editor-state";
import { toPrismaJson } from "@/lib/prisma-json";
import { deleteObject } from "@/lib/storage/object-store";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const [{ id }, user] = await Promise.all([params, resolveRequestUser(request)]);
    const project = await prisma.project.findFirst({
      where: {
        id,
        userId: user.id,
      },
      include: {
        preference: true,
        _count: {
          select: {
            artifacts: true,
            references: true,
            drafts: true,
            runs: true,
          },
        },
      },
    });

    if (!project) {
      return Response.json({ error: { code: "NOT_FOUND", message: "Project not found." } }, { status: 404 });
    }

    return jsonOk(project);
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const [{ id }, user] = await Promise.all([params, resolveRequestUser(request)]);
    const payload = await parseJson(request, projectPreferenceUpdateSchema);

    const project = await prisma.project.findFirst({
      where: {
        id,
        userId: user.id,
      },
      select: {
        id: true,
      },
    });

    if (!project) {
      return Response.json({ error: { code: "NOT_FOUND", message: "Project not found." } }, { status: 404 });
    }

    if (payload.defaultEndpointId) {
      const endpoint = await prisma.providerEndpoint.findFirst({
        where: {
          id: payload.defaultEndpointId,
          userId: user.id,
          archivedAt: null,
        },
        select: { id: true },
      });

      if (!endpoint) {
        return Response.json({ error: { code: "NOT_FOUND", message: "Default endpoint not found." } }, { status: 404 });
      }
    }

    if (payload.activeChapterArtifactId) {
      const artifact = await prisma.workspaceArtifact.findFirst({
        where: {
          id: payload.activeChapterArtifactId,
          projectId: id,
          kind: "project_chapter",
        },
        select: { id: true },
      });

      if (!artifact) {
        return Response.json({ error: { code: "NOT_FOUND", message: "Active chapter artifact not found." } }, { status: 404 });
      }
    }

    if (payload.apiPresets) {
      const endpointIds = [...new Set(payload.apiPresets.map((preset) => preset.endpointId).filter(Boolean))];

      for (const endpointId of endpointIds) {
        const endpoint = await prisma.providerEndpoint.findFirst({
          where: {
            id: endpointId!,
            userId: user.id,
            archivedAt: null,
          },
          select: { id: true },
        });

        if (!endpoint) {
          return Response.json(
            {
              error: {
                code: "NOT_FOUND",
                message: `Preset endpoint not found: ${endpointId}`,
              },
            },
            { status: 404 },
          );
        }
      }
    }

    const updateData: Prisma.ProjectPreferenceUncheckedUpdateInput = {};

    if (payload.defaultEndpointId !== undefined) {
      updateData.defaultEndpointId = payload.defaultEndpointId;
    }
    if (payload.defaultModel !== undefined) {
      updateData.defaultModel = payload.defaultModel;
    }
    if (payload.defaultTaskType !== undefined) {
      updateData.defaultTaskType = payload.defaultTaskType;
    }
    if (payload.activeChapterArtifactId !== undefined) {
      updateData.activeChapterArtifactId = payload.activeChapterArtifactId;
    }
    if (payload.apiPresets !== undefined) {
      updateData.apiPresets = toPrismaJson(normalizeApiPresets(payload.apiPresets, { fallbackToDefaults: false }));
    }

    const createData: Prisma.ProjectPreferenceUncheckedCreateInput = {
      projectId: id,
      defaultEndpointId: payload.defaultEndpointId ?? null,
      defaultModel: payload.defaultModel ?? null,
      defaultTaskType: payload.defaultTaskType ?? "workflow_check",
      ledgerEnabled: false,
      showSelfCheck: true,
      showSettlement: true,
      activeChapterArtifactId: payload.activeChapterArtifactId ?? null,
      apiPresets: toPrismaJson(normalizeApiPresets(payload.apiPresets)),
      chapterIndex: toPrismaJson([]),
      editorLayoutPrefs: toPrismaJson(buildDefaultEditorLayoutPrefs()),
    };

    const preference = await prisma.projectPreference.upsert({
      where: {
        projectId: id,
      },
      update: updateData,
      create: createData,
    });

    return jsonOk({ preference });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const [{ id }, user] = await Promise.all([params, resolveRequestUser(request)]);
    const project = await prisma.project.findFirst({
      where: {
        id,
        userId: user.id,
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

    if (!project) {
      return Response.json({ error: { code: "NOT_FOUND", message: "Project not found." } }, { status: 404 });
    }

    const exportRecords = normalizeProjectExportRecords(project.preference?.exportRecords);
    const objectKeys = [...new Set([
      ...project.references.map((reference) => reference.storageKey).filter((value): value is string => Boolean(value)),
      ...project.runs.map((run) => run.archiveStorageKey).filter((value): value is string => Boolean(value)),
      ...exportRecords.map((record) => record.storageKey),
    ])];

    await prisma.project.delete({
      where: {
        id,
      },
    });

    await Promise.allSettled(objectKeys.map((key) => deleteObject(key)));

    return jsonOk({
      deletedProjectId: id,
      deletedObjectCount: objectKeys.length,
    });
  } catch (error) {
    return jsonError(error);
  }
}
