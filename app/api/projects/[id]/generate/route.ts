import type { HealthStatus, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { ApiError, jsonCreated, jsonError, parseJson } from "@/lib/api/http";
import { generateRequestSchema } from "@/lib/api/schemas";
import { resolveRequestUser } from "@/lib/auth/identity";
import { composeResolvedPrompt, resolveTaskDefinition } from "@/lib/generation/compose";
import { buildProjectContext, buildSelectedReferences } from "@/lib/generation/context";
import {
  executeGeneration,
  executeGenerationStream,
  normalizeGenerationError,
  shouldUseStreamingGeneration,
} from "@/lib/generation/execute";
import { buildGenerationArchiveCandidate, buildGenerationArchiveDownloadPath } from "@/lib/generation/archive";
import {
  buildDefaultEditorLayoutPrefs,
  countNovelWords,
  normalizeChapterIndex,
  updateChapterIndexEntry,
} from "@/lib/projects/editor-state";
import { resolveGrokRuntimeConfig } from "@/lib/search/grok-config";
import { resolveExternalFacts } from "@/lib/search/grok";
import { getGrokSearchTrace } from "@/lib/search/grok-source-cache";
import { deleteObject, putObject } from "@/lib/storage/object-store";
import { toPrismaJson } from "@/lib/prisma-json";

function buildSuggestedPatches(taskType: string) {
  switch (taskType) {
    case "ingest_sources":
      return ["findings.md"];
    case "research_fact_check":
      return ["findings.md"];
    case "generate_chapter":
      return ["progress.md", "99_当前状态卡.md"];
    case "review_content":
      return ["findings.md"];
    case "sync_state":
      return ["99_当前状态卡.md", "progress.md"];
    default:
      return [];
  }
}

function mapGenerationErrorToHealthStatus(error: ApiError): HealthStatus {
  switch (error.code) {
    case "AUTH_ERROR":
      return "invalid_auth";
    case "NETWORK_ERROR":
    case "TIMEOUT":
    case "SEARCH_UNAVAILABLE":
      return "unreachable";
    case "MODEL_UNAVAILABLE":
    case "OUTPUT_CONTRACT_ERROR":
      return "degraded";
    default:
      return "misconfigured";
  }
}

function shouldUseExternalFacts(taskType: string, requireExternalFacts?: boolean) {
  return taskType === "research_fact_check" || Boolean(requireExternalFacts);
}

function mergeSummaryObjects(...summaries: Array<Record<string, unknown> | undefined>) {
  return summaries.reduce<Record<string, unknown>>((merged, summary) => {
    if (!summary) {
      return merged;
    }

    return {
      ...merged,
      ...summary,
    };
  }, {});
}

function mergeToolCallSummary(executionSummary: unknown, supplementalSummary?: Record<string, unknown>) {
  const baseSummary =
    executionSummary && typeof executionSummary === "object" && !Array.isArray(executionSummary)
      ? executionSummary
      : {};

  if (!supplementalSummary) {
    return baseSummary;
  }

  return {
    ...baseSummary,
    ...supplementalSummary,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractExternalSearchSessionId(summary: unknown) {
  if (!isRecord(summary) || !isRecord(summary.externalSearch)) {
    return null;
  }

  const sessionId = summary.externalSearch.sessionId;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
}

function appendUniqueArtifacts<
  T extends {
    id: string;
    artifactKey: string;
    filename: string;
  },
>(artifacts: T[]) {
  const seen = new Set<string>();

  return artifacts.filter((artifact) => {
    if (seen.has(artifact.id)) {
      return false;
    }

    seen.add(artifact.id);
    return true;
  });
}

type ResolvedArtifactSummary = {
  id: string;
  artifactKey: string;
  filename: string;
};

type SuccessfulGenerationPayload = {
  draftId: string;
  runId: string;
  resolvedPrompt: string;
  resolvedSkills: string[];
  resolvedArtifacts: ResolvedArtifactSummary[];
  output: string;
  suggestedPatches: string[];
  toolCallsSummary: unknown;
  archiveDownloadUrl: string | null;
  archiveObjectStoreMode: string | null;
  archiveByteSize: number | null;
  archiveContentType: string | null;
};

type PersistSuccessfulGenerationInput = {
  projectId: string;
  runId: string;
  endpointId: string;
  taskType: string;
  targetArtifact: { id: string; kind: string } | null;
  output: string;
  suggestedPatches: string[];
  usage: Prisma.InputJsonValue;
  finalToolCallsSummary: Prisma.InputJsonValue;
  storedArchive: Awaited<ReturnType<typeof putObject>> | null;
  archiveCandidate: ReturnType<typeof buildGenerationArchiveCandidate>;
};

function buildSuccessfulGenerationPayload(input: {
  projectId: string;
  runId: string;
  draftId: string;
  resolvedPrompt: string;
  resolvedSkills: string[];
  resolvedArtifacts: ResolvedArtifactSummary[];
  output: string;
  suggestedPatches: string[];
  toolCallsSummary: unknown;
  storedArchive: Awaited<ReturnType<typeof putObject>> | null;
  archiveCandidate: ReturnType<typeof buildGenerationArchiveCandidate>;
}): SuccessfulGenerationPayload {
  return {
    draftId: input.draftId,
    runId: input.runId,
    resolvedPrompt: input.resolvedPrompt,
    resolvedSkills: input.resolvedSkills,
    resolvedArtifacts: input.resolvedArtifacts,
    output: input.output,
    suggestedPatches: input.suggestedPatches,
    toolCallsSummary: input.toolCallsSummary,
    archiveDownloadUrl: input.storedArchive ? buildGenerationArchiveDownloadPath(input.projectId, input.runId) : null,
    archiveObjectStoreMode: input.storedArchive?.mode ?? null,
    archiveByteSize: input.archiveCandidate?.byteSize ?? null,
    archiveContentType: input.archiveCandidate?.contentType ?? null,
  };
}

async function persistSuccessfulGeneration(input: PersistSuccessfulGenerationInput) {
  const draft = await prisma.$transaction(async (tx) => {
    await tx.providerEndpoint.update({
      where: { id: input.endpointId },
      data: {
        healthStatus: "healthy",
        lastHealthCheckAt: new Date(),
      },
    });

    const nextDraft = await tx.draft.create({
      data: {
        projectId: input.projectId,
        runId: input.runId,
        artifactId: input.targetArtifact?.id,
        taskType: input.taskType,
        outputContent: input.output,
        suggestedPatches: input.suggestedPatches,
        status: "ready",
        draftKind: input.taskType === "review_content" ? "review_revision" : "generated_output",
      },
    });

    await tx.generationRun.update({
      where: { id: input.runId },
      data: {
        usage: input.usage,
        toolCallsSummary: input.finalToolCallsSummary,
        archiveStorageKey: input.storedArchive?.key ?? null,
        archiveObjectStoreMode: input.storedArchive?.mode ?? null,
        archiveByteSize: input.archiveCandidate?.byteSize ?? null,
        archiveContentType: input.archiveCandidate?.contentType ?? null,
        status: "succeeded",
        errorSummary: null,
      },
    });

    if (input.targetArtifact?.kind === "project_chapter") {
      const preference = await tx.projectPreference.findUnique({
        where: {
          projectId: input.projectId,
        },
      });
      const chapterIndex = normalizeChapterIndex(preference?.chapterIndex);
      const nextChapterIndex = updateChapterIndexEntry(chapterIndex, input.targetArtifact.id, {
        latestDraftId: nextDraft.id,
        wordCount: countNovelWords(input.output),
        status: "reviewing",
        updatedAt: new Date().toISOString(),
      });

      await tx.projectPreference.upsert({
        where: {
          projectId: input.projectId,
        },
        update: {
          chapterIndex: toPrismaJson(nextChapterIndex),
          activeChapterArtifactId: input.targetArtifact.id,
        },
        create: {
          projectId: input.projectId,
          defaultTaskType: "workflow_check",
          ledgerEnabled: false,
          showSelfCheck: true,
          showSettlement: true,
          activeChapterArtifactId: input.targetArtifact.id,
          chapterIndex: toPrismaJson(nextChapterIndex),
          editorLayoutPrefs: toPrismaJson(buildDefaultEditorLayoutPrefs()),
        },
      });
    }

    return nextDraft;
  });

  return draft;
}

async function markGenerationFailed(runId: string, normalized: ApiError) {
  await Promise.allSettled([
    prisma.generationRun.update({
      where: { id: runId },
      data: {
        status: "failed",
        errorSummary: normalized.message,
      },
    }),
    prisma.providerEndpoint.updateMany({
      where: {
        generationRuns: {
          some: {
            id: runId,
          },
        },
      },
      data: {
        healthStatus: mapGenerationErrorToHealthStatus(normalized),
        lastHealthCheckAt: new Date(),
      },
    }),
  ]);
}

function createNdjsonStreamWriter() {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  return {
    readable,
    async write(data: unknown) {
      await writer.write(encoder.encode(`${JSON.stringify(data)}\n`));
    },
    async close() {
      await writer.close();
    },
  };
}

function requestWantsNdjson(request: Request) {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("application/x-ndjson");
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let runId: string | undefined;
  let createdArchiveStorageKey: string | undefined;

  try {
    const [{ id }, user] = await Promise.all([params, resolveRequestUser(request)]);
    const payload = await parseJson(request, generateRequestSchema);

    const project = await prisma.project.findFirst({
      where: {
        id,
        userId: user.id,
      },
      include: {
        preference: true,
      },
    });

    if (!project) {
      return Response.json({ error: { code: "NOT_FOUND", message: "Project not found." } }, { status: 404 });
    }

    const endpoint = await prisma.providerEndpoint.findFirst({
      where: {
        id: payload.endpointId,
        userId: user.id,
        archivedAt: null,
      },
    });

    if (!endpoint) {
      return Response.json({ error: { code: "NOT_FOUND", message: "Endpoint not found." } }, { status: 404 });
    }

    const taskDefinition = await resolveTaskDefinition(payload.taskType);
    const requiresExternalFacts = shouldUseExternalFacts(
      payload.taskType,
      payload.generationOptions.requireExternalFacts,
    );

    if (payload.selectedMcpServerIds.length > 0 && !taskDefinition.task.supportsMcp) {
      throw new ApiError(422, "VALIDATION_ERROR", `Task "${payload.taskType}" does not support MCP servers.`);
    }

    if (requiresExternalFacts && !taskDefinition.task.supportsSearch) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        `Task "${payload.taskType}" does not support external fact supplementation.`,
      );
    }

    const targetArtifact = payload.targetArtifactId
      ? await prisma.workspaceArtifact.findFirst({
          where: {
            id: payload.targetArtifactId,
            projectId: id,
          },
          include: {
            currentRevision: true,
          },
        })
      : null;

    if (payload.targetArtifactId && !targetArtifact) {
      throw new ApiError(404, "NOT_FOUND", "Target artifact not found.");
    }

    const selectedArtifactIds =
      payload.selectedArtifactIds.length > 0
        ? [...new Set(payload.selectedArtifactIds)]
        : [];
    const artifactWhere = {
      projectId: id,
      OR: [
        ...(taskDefinition.task.requiresArtifacts.length > 0
          ? [
              {
                artifactKey: {
                  in: taskDefinition.task.requiresArtifacts,
                },
              },
            ]
          : []),
        ...(selectedArtifactIds.length > 0
          ? [
              {
                id: {
                  in: selectedArtifactIds,
                },
              },
            ]
          : []),
        ...(targetArtifact
          ? [
              {
                id: targetArtifact.id,
              },
            ]
          : []),
      ],
    };

    const artifacts =
      artifactWhere.OR.length > 0
        ? await prisma.workspaceArtifact.findMany({
            where: artifactWhere,
            include: {
              currentRevision: true,
            },
            orderBy: { filename: "asc" },
          })
        : [];
    const projectOverlayArtifacts = await prisma.workspaceArtifact.findMany({
      where: {
        projectId: id,
        artifactKey: {
          in: ["project_prompt_pack", "project_skill_pack"],
        },
      },
      include: {
        currentRevision: true,
      },
      orderBy: { filename: "asc" },
    });
    const projectPromptOverlay =
      projectOverlayArtifacts.find((artifact) => artifact.artifactKey === "project_prompt_pack")?.currentRevision?.content ??
      "";
    const projectSkillOverlay =
      projectOverlayArtifacts.find((artifact) => artifact.artifactKey === "project_skill_pack")?.currentRevision?.content ??
      "";
    const contextArtifacts = artifacts.filter(
      (artifact) => artifact.artifactKey !== "project_prompt_pack" && artifact.artifactKey !== "project_skill_pack",
    );
    const resolvedArtifactsForRun = appendUniqueArtifacts([...contextArtifacts, ...projectOverlayArtifacts]);

    const references = payload.selectedReferenceIds.length
      ? await prisma.referenceDocument.findMany({
          where: {
            projectId: id,
            id: { in: payload.selectedReferenceIds },
          },
          orderBy: { createdAt: "desc" },
        })
      : [];

    const mcpServers = payload.selectedMcpServerIds.length
      ? await prisma.mcpServer.findMany({
          where: {
            userId: user.id,
            id: { in: payload.selectedMcpServerIds },
          },
          orderBy: { name: "asc" },
        })
      : [];
    const chapterArtifactIds = contextArtifacts
      .filter((artifact) => artifact.kind === "project_chapter")
      .map((artifact) => artifact.id);
    const autosaveDrafts = chapterArtifactIds.length
      ? await prisma.draft.findMany({
          where: {
            projectId: id,
            draftKind: "editor_autosave",
            artifactId: {
              in: chapterArtifactIds,
            },
          },
          orderBy: { updatedAt: "desc" },
        })
      : [];
    const latestAutosaveDrafts = Array.from(
      autosaveDrafts.reduce((map, draft) => {
        if (!draft.artifactId || map.has(draft.artifactId)) {
          return map;
        }

        map.set(draft.artifactId, {
          artifactId: draft.artifactId,
          outputContent: draft.outputContent,
        });
        return map;
      }, new Map<string, { artifactId: string; outputContent: string }>()),
      ([, overlay]) => overlay,
    );

    const projectContext = buildProjectContext(contextArtifacts, latestAutosaveDrafts);
    const selectedReferences = buildSelectedReferences(references);
    const selectedMcpTools =
      mcpServers.length > 0
        ? mcpServers.map((server) => `${server.name} (${server.transportType})`).join("\n")
        : "无";
    const externalPromptTemplate = payload.generationOptions.externalPromptTemplate?.content.trim()
      ? payload.generationOptions.externalPromptTemplate
      : undefined;
    const currentTime = new Date().toISOString();
    const grokConfig = requiresExternalFacts ? await resolveGrokRuntimeConfig(user.id) : null;
    const externalFactsResolution = requiresExternalFacts
      ? await resolveExternalFacts({
          projectId: id,
          taskType: payload.taskType,
          userInstruction: payload.userInstruction,
          projectContext,
          selectedReferences,
          currentTime,
        }, grokConfig)
      : null;

    const composed = await composeResolvedPrompt({
      taskType: payload.taskType,
      userInstruction: payload.userInstruction,
      projectContext,
      projectPromptOverlay,
      projectSkillOverlay,
      selectedReferences,
      selectedMcpTools,
      externalFacts: externalFactsResolution?.factsForPrompt ?? "无",
      externalPromptTemplate: externalPromptTemplate?.content,
      externalPromptLabel: externalPromptTemplate
        ? `${externalPromptTemplate.serverName} / ${externalPromptTemplate.promptName}`
        : undefined,
      currentTime,
    });
    const suggestedPatches = buildSuggestedPatches(payload.taskType);
    const supplementalSummary = mergeSummaryObjects(
      externalFactsResolution?.toolCallSummary,
      externalPromptTemplate
        ? {
            externalPromptTemplate: {
              source: externalPromptTemplate.source,
              serverId: externalPromptTemplate.serverId,
              serverName: externalPromptTemplate.serverName,
              promptName: externalPromptTemplate.promptName,
              preview: externalPromptTemplate.content.slice(0, 1200),
            },
          }
        : undefined,
    );
    const supplementalSummaryJson =
      Object.keys(supplementalSummary).length > 0 ? toPrismaJson(supplementalSummary) : undefined;

    const run = await prisma.generationRun.create({
      data: {
        projectId: id,
        taskType: payload.taskType,
        endpointId: endpoint.id,
        modelId: payload.modelId,
        selectedArtifactIds: resolvedArtifactsForRun.map((artifact) => artifact.id),
        selectedReferenceIds: references.map((reference) => reference.id),
        selectedMcpServerIds: mcpServers.map((server) => server.id),
        resolvedPrompt: composed.resolvedPrompt,
        resolvedSkills: composed.resolvedSkills.map((skill) => ({ name: skill.name })),
        resolvedContextArtifacts: resolvedArtifactsForRun.map((artifact) => ({
          id: artifact.id,
          artifactKey: artifact.artifactKey,
          filename: artifact.filename,
        })),
        toolCallsSummary: supplementalSummaryJson,
        usage: {
          stage: "running",
        },
        status: "running",
      },
    });
    runId = run.id;

    const persistCompletedGeneration = async (execution: {
      output: string;
      usage: Prisma.InputJsonValue;
      toolCallsSummary: Prisma.InputJsonValue;
    }) => {
      const finalToolCallsSummary = mergeToolCallSummary(
        execution.toolCallsSummary,
        supplementalSummaryJson && typeof supplementalSummaryJson === "object" && !Array.isArray(supplementalSummaryJson)
          ? (supplementalSummaryJson as Record<string, unknown>)
          : undefined,
      );
      const externalSearchSessionId = extractExternalSearchSessionId(finalToolCallsSummary);
      const externalSearchTrace = externalSearchSessionId
        ? await getGrokSearchTrace(id, externalSearchSessionId)
        : null;
      const archiveCandidate = buildGenerationArchiveCandidate({
        projectId: id,
        runId: run.id,
        taskType: payload.taskType,
        endpointId: endpoint.id,
        modelId: payload.modelId,
        resolvedPrompt: composed.resolvedPrompt,
        resolvedSkills: composed.resolvedSkills.map((skill) => ({ name: skill.name })),
        resolvedContextArtifacts: resolvedArtifactsForRun.map((artifact) => ({
          id: artifact.id,
          artifactKey: artifact.artifactKey,
          filename: artifact.filename,
        })),
        toolCallsSummary: finalToolCallsSummary,
        usage: execution.usage,
        output: execution.output,
        suggestedPatches,
        targetArtifactId: targetArtifact?.id,
        externalSearchTrace: externalSearchTrace
          ? {
              sessionId: externalSearchTrace.sessionId,
              createdAt: externalSearchTrace.createdAt.toISOString(),
              requestPayload: externalSearchTrace.requestPayload,
              responsePayload: externalSearchTrace.responsePayload,
              sourceItems: externalSearchTrace.sourceItems,
            }
          : null,
      });
      const storedArchive = archiveCandidate
        ? await putObject({
            key: archiveCandidate.key,
            body: archiveCandidate.body,
            contentType: archiveCandidate.contentType,
            metadata: {
              projectId: id,
              runId: run.id,
              taskType: payload.taskType,
            },
          })
        : null;

      createdArchiveStorageKey = storedArchive?.key;

      const draft = await persistSuccessfulGeneration({
        projectId: id,
        runId: run.id,
        endpointId: endpoint.id,
        taskType: payload.taskType,
        targetArtifact: targetArtifact
          ? {
              id: targetArtifact.id,
              kind: targetArtifact.kind,
            }
          : null,
        output: execution.output,
        suggestedPatches,
        usage: execution.usage,
        finalToolCallsSummary,
        storedArchive,
        archiveCandidate,
      });

      return buildSuccessfulGenerationPayload({
        projectId: id,
        runId: run.id,
        draftId: draft.id,
        resolvedPrompt: composed.resolvedPrompt,
        resolvedSkills: composed.resolvedSkills.map((skill) => skill.name),
        resolvedArtifacts: resolvedArtifactsForRun.map((artifact) => ({
          id: artifact.id,
          artifactKey: artifact.artifactKey,
          filename: artifact.filename,
        })),
        output: execution.output,
        suggestedPatches,
        toolCallsSummary: finalToolCallsSummary,
        storedArchive,
        archiveCandidate,
      });
    };

    if (shouldUseStreamingGeneration(endpoint) && requestWantsNdjson(request)) {
      const execution = await executeGenerationStream({
        endpoint,
        modelId: payload.modelId,
        prompt: composed.resolvedPrompt,
        temperature: payload.generationOptions.temperature,
        maxOutputTokens: payload.generationOptions.maxTokens,
        mcpServers,
      });
      const stream = createNdjsonStreamWriter();

      void (async () => {
        try {
          await stream.write({
            type: "started",
            runId: run.id,
          });

          for await (const chunk of execution.textStream) {
            if (!chunk) {
              continue;
            }

            await stream.write({
              type: "text-delta",
              text: chunk,
            });
          }

          const successPayload = await persistCompletedGeneration(await execution.completed);
          createdArchiveStorageKey = undefined;

          await stream.write({
            type: "completed",
            payload: successPayload,
          });
        } catch (error) {
          if (createdArchiveStorageKey) {
            await deleteObject(createdArchiveStorageKey).catch(() => undefined);
            createdArchiveStorageKey = undefined;
          }

          const normalized = normalizeGenerationError(error);
          await markGenerationFailed(run.id, normalized);
          await stream.write({
            type: "error",
            error: {
              code: normalized.code,
              message: normalized.message,
              details: normalized.details ?? null,
            },
          });
        } finally {
          await stream.close().catch(() => undefined);
        }
      })();

      return new Response(stream.readable, {
        status: 200,
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
        },
      });
    }

    const execution = await executeGeneration({
      endpoint,
      modelId: payload.modelId,
      prompt: composed.resolvedPrompt,
      temperature: payload.generationOptions.temperature,
      maxOutputTokens: payload.generationOptions.maxTokens,
      mcpServers,
    });
    const successPayload = await persistCompletedGeneration(execution);
    createdArchiveStorageKey = undefined;

    return jsonCreated(successPayload);
  } catch (error) {
    if (createdArchiveStorageKey) {
      await deleteObject(createdArchiveStorageKey).catch(() => undefined);
    }

    if (runId) {
      const normalized = normalizeGenerationError(error);
      await markGenerationFailed(runId, normalized);

      return jsonError(normalized);
    }

    return jsonError(error);
  }
}
