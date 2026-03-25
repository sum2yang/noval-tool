"use client";

import promptRouting from "@/knowledge/schemas/prompt-routing.json";
import skillComposition from "@/knowledge/schemas/skill-composition.json";
import taskTypes from "@/knowledge/schemas/task-types.json";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";

import { SectionPanel } from "@/components/section-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getProviderTypeLabel } from "@/lib/integrations/display-labels";
import { getHealthStatusLabel } from "@/lib/integrations/health-status";
import {
  buildAppliedApiPresetState,
  normalizeApiPresets,
  type ApiPreset,
  type ApiPresetKey,
} from "@/lib/projects/api-presets";
import { getArtifactDisplayLabel, getArtifactDisplayName } from "@/lib/projects/artifact-display";
import {
  buildChapterGuidanceBrief,
  buildChapterGuidancePrompt,
  buildChapterGuidanceRunInstruction,
} from "@/lib/projects/chapter-guidance";
import type { ChapterIndexEntry, EditorLayoutPrefs } from "@/lib/projects/editor-state";
import { countNovelWords } from "@/lib/projects/editor-state";
import { buildOperatorErrorMessage } from "@/lib/runs/diagnostics";
import {
  getDraftKindLabel,
  getDraftStatusLabel,
  getPromptTemplateLabel,
  getSkillDisplayLabel,
  getTaskDescription,
  getTaskDisplayLabel,
  getTaskLabel,
  getTaskMeta,
} from "@/lib/tasks/catalog";
import { cn } from "@/lib/utils";
import type { TaskType } from "@/lib/types/domain";
import { TASK_TYPES } from "@/lib/types/domain";

import { McpCapabilityBrowser, type AppliedMcpPromptTemplate } from "./mcp-capability-browser";
import { NovelEditor } from "./novel-editor";
import { ProjectPreferenceForm } from "./project-preference-form";
import { ReviewEditor } from "./review-editor";
import type { WorkbenchMode } from "./workbench-modes";
import { RunDiagnosticsSummary } from "./run-diagnostics-summary";

type ArtifactItem = {
  id: string;
  artifactKey: string;
  filename: string;
  kind: string;
  currentRevision: {
    id: string;
    content: string;
    summary: string;
    createdAt: string | Date;
  } | null;
};

type ReferenceItem = {
  id: string;
  filename: string;
  sourceType: string;
  normalizedText: string | null;
  extractedText: string | null;
};

type DraftItem = {
  id: string;
  artifactId?: string | null;
  taskType: string;
  outputContent: string;
  suggestedPatches: unknown;
  status: string;
  draftKind: string;
  updatedAt: string | Date;
  run?: {
    id: string;
    resolvedContextArtifacts: unknown;
  } | null;
};

type EndpointItem = {
  id: string;
  providerType: string;
  label: string;
  baseURL: string;
  authMode: string;
  defaultModel: string;
  healthStatus: string;
  lastHealthCheckAt?: string | Date | null;
  updatedAt: string | Date;
};

type McpServerItem = {
  id: string;
  name: string;
  transportType: string;
  serverUrl: string;
  authMode: string;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  healthStatus: string;
  lastSyncAt?: string | Date | null;
  updatedAt: string | Date;
};

type ProjectPreference = {
  defaultEndpointId?: string | null;
  defaultModel?: string | null;
  defaultTaskType?: string | null;
  apiPresets?: unknown;
};

type WorkbenchRunConsoleProps = {
  mode: WorkbenchMode;
  project: {
    id: string;
    name: string;
    genre: string;
    platform: string;
    preference: ProjectPreference | null;
    chapterIndex: ChapterIndexEntry[];
    editorLayoutPrefs: EditorLayoutPrefs;
    activeChapterArtifactId: string | null;
    artifacts: ArtifactItem[];
    references: ReferenceItem[];
    drafts: DraftItem[];
    editorAutosaveDraft: DraftItem | null;
    providerEndpoints: EndpointItem[];
    mcpServers: McpServerItem[];
  };
};

type LatestRunState = {
  draftId: string;
  runId: string;
  output: string;
  resolvedPrompt: string;
  resolvedSkills: string[];
  resolvedArtifacts: Array<{ id: string; artifactKey: string; filename: string }>;
  suggestedPatches: string[];
  toolCallsSummary: unknown;
  archiveDownloadUrl: string | null;
  archiveObjectStoreMode: string | null;
  archiveByteSize: number | null;
  archiveContentType: string | null;
};

type GenerateStreamEvent =
  | {
      type: "started";
      runId: string;
    }
  | {
      type: "text-delta";
      text: string;
    }
  | {
      type: "completed";
      payload: unknown;
    }
  | {
      type: "error";
      error: {
        code?: string;
        message?: string;
        details?: unknown;
      };
    };

type PromptRoutingRow = {
  taskType: string;
  promptFile: string;
  outputContract: string;
};

type SkillCompositionRow = {
  taskType: string;
  skills: string[];
};

type TaskTypeRow = {
  taskType: string;
  requiresArtifacts: string[];
  outputContract: string;
};

type TaskConfig = {
  taskType: string;
  label: string;
  description: string;
  promptFile: string;
  outputContract: string;
  requiredArtifacts: string[];
  skills: string[];
  supportsMcp: boolean;
  supportsSearch: boolean;
};

const TASK_CONFIGS = TASK_TYPES.map((taskType) => {
  const prompt = (promptRouting as PromptRoutingRow[]).find((item) => item.taskType === taskType);
  const skillSet = (skillComposition as SkillCompositionRow[]).find((item) => item.taskType === taskType);
  const taskMeta = (taskTypes as TaskTypeRow[]).find((item) => item.taskType === taskType);
  const catalogMeta = getTaskMeta(taskType);

  return {
    taskType,
    label: catalogMeta.label,
    description: catalogMeta.description,
    promptFile: prompt?.promptFile ?? "workflow_check.md",
    outputContract: prompt?.outputContract ?? taskMeta?.outputContract ?? "结构化结果 + 需更新文件",
    requiredArtifacts: taskMeta?.requiresArtifacts ?? [],
    skills: skillSet?.skills ?? [],
    supportsMcp: catalogMeta.supportsMcp,
    supportsSearch: catalogMeta.supportsSearch,
  } satisfies TaskConfig;
});

const TASK_CONFIG_BY_TYPE = new Map(TASK_CONFIGS.map((config) => [config.taskType, config]));

function formatTime(value: Date | string | undefined | null) {
  if (!value) {
    return "未更新";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function previewText(value: string | null | undefined, limit = 180) {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "暂无内容。";
  }

  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function formatByteSize(value: number | null | undefined) {
  if (!value || value <= 0) {
    return "未记录大小";
  }

  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function toStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildDefaultInstruction(taskType: string) {
  switch (taskType) {
    case "ingest_sources":
      return "请提炼参考资料里的规则、流程、冲突来源和建议回填文件。";
    case "research_fact_check":
      return "请核查当前任务需要的真实事实，输出结论、来源摘要、冲突点和可写入项目的事实补充。";
    case "review_content":
      return "请先定位问题，再给出证据和最小修法。";
    case "generate_setting":
      return "沉淀新的角色和世界设定，并保持现有状态一致。";
    case "sync_state":
      return "根据最新正文和 findings，同步状态卡与进度记录。";
    default:
      return "续写下一章，保持平台收益逻辑和主角利益链一致。";
  }
}

function readErrorMessage(payload: unknown) {
  return buildOperatorErrorMessage(payload);
}

function normalizeResolvedArtifacts(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is { id: string; artifactKey: string; filename: string } => {
      return (
        isRecord(item) &&
        typeof item.id === "string" &&
        typeof item.artifactKey === "string" &&
        typeof item.filename === "string"
      );
    })
    .map((item) => ({
      id: item.id,
      artifactKey: item.artifactKey,
      filename: item.filename,
    }));
}

function parseLatestRunState(payload: unknown): LatestRunState | null {
  if (!isRecord(payload)) {
    return null;
  }

  if (
    typeof payload.draftId !== "string" ||
    typeof payload.runId !== "string" ||
    typeof payload.output !== "string" ||
    typeof payload.resolvedPrompt !== "string"
  ) {
    return null;
  }

  return {
    draftId: payload.draftId,
    runId: payload.runId,
    output: payload.output,
    resolvedPrompt: payload.resolvedPrompt,
    resolvedSkills: toStringArray(payload.resolvedSkills),
    resolvedArtifacts: normalizeResolvedArtifacts(payload.resolvedArtifacts),
    suggestedPatches: toStringArray(payload.suggestedPatches),
    toolCallsSummary: payload.toolCallsSummary ?? null,
    archiveDownloadUrl:
      typeof payload.archiveDownloadUrl === "string" && payload.archiveDownloadUrl.trim()
        ? payload.archiveDownloadUrl
        : null,
    archiveObjectStoreMode: typeof payload.archiveObjectStoreMode === "string" ? payload.archiveObjectStoreMode : null,
    archiveByteSize: typeof payload.archiveByteSize === "number" ? payload.archiveByteSize : null,
    archiveContentType: typeof payload.archiveContentType === "string" ? payload.archiveContentType : null,
  };
}

function parseGenerateStreamEvent(payload: unknown): GenerateStreamEvent | null {
  if (!isRecord(payload) || typeof payload.type !== "string") {
    return null;
  }

  switch (payload.type) {
    case "started":
      return typeof payload.runId === "string" ? { type: "started", runId: payload.runId } : null;
    case "text-delta":
      return typeof payload.text === "string" ? { type: "text-delta", text: payload.text } : null;
    case "completed":
      return {
        type: "completed",
        payload: payload.payload ?? null,
      };
    case "error":
      return {
        type: "error",
        error: isRecord(payload.error)
          ? {
              code: typeof payload.error.code === "string" ? payload.error.code : undefined,
              message: typeof payload.error.message === "string" ? payload.error.message : undefined,
              details: payload.error.details,
            }
          : {},
      };
    default:
      return null;
  }
}

function filterArtifactsByKeys(artifacts: ArtifactItem[], artifactKeys: string[]) {
  const keySet = new Set(artifactKeys);
  return artifacts.filter((artifact) => keySet.has(artifact.artifactKey));
}

function buildDraftArtifactCandidates(draft: DraftItem, artifacts: ArtifactItem[]) {
  if (draft.artifactId) {
    const boundArtifact = artifacts.find((artifact) => artifact.id === draft.artifactId);
    if (boundArtifact) {
      return [boundArtifact];
    }
  }

  const suggestedNames = new Set(toStringArray(draft.suggestedPatches));
  if (suggestedNames.size > 0) {
    const matched = artifacts.filter((artifact) => suggestedNames.has(artifact.filename));
    if (matched.length > 0) {
      return matched;
    }
  }

  switch (draft.taskType) {
    case "generate_setting": {
      const settingArtifacts = artifacts.filter((artifact) => artifact.kind === "project_setting");
      return settingArtifacts.length > 0 ? settingArtifacts : artifacts;
    }
    case "generate_outline": {
      const outlineArtifacts = filterArtifactsByKeys(artifacts, ["outline_master", "task_plan"]);
      return outlineArtifacts.length > 0 ? outlineArtifacts : artifacts;
    }
    case "workflow_check":
    case "sync_state": {
      const stateArtifacts = filterArtifactsByKeys(artifacts, ["task_plan", "findings", "progress", "current_state_card"]);
      return stateArtifacts.length > 0 ? stateArtifacts : artifacts;
    }
    case "review_content":
    case "research_fact_check": {
      const reviewArtifacts = filterArtifactsByKeys(artifacts, ["findings"]);
      return reviewArtifacts.length > 0 ? reviewArtifacts : artifacts;
    }
    case "ingest_sources": {
      const findingsArtifacts = filterArtifactsByKeys(artifacts, ["findings"]);
      return findingsArtifacts.length > 0 ? findingsArtifacts : artifacts;
    }
    case "generate_chapter": {
      const chapterArtifacts = artifacts.filter((artifact) => artifact.kind === "project_chapter");
      return chapterArtifacts.length > 0 ? chapterArtifacts : artifacts;
    }
    default:
      return artifacts;
  }
}

function buildDefaultAcceptSummary(draft: DraftItem, artifact: ArtifactItem | undefined) {
  return `${getTaskLabel(draft.taskType)} 回填到 ${artifact ? getArtifactDisplayLabel(artifact.artifactKey, artifact.filename) : "目标文件"}`;
}

function buildTaskOperatorHints(
  taskConfig: TaskConfig,
  options: {
    hasReferences: boolean;
    hasActiveChapter: boolean;
  },
) {
  const hints: string[] = [`这一步会做什么：${taskConfig.description}`];

  switch (taskConfig.taskType) {
    case "ingest_sources":
      hints.push(options.hasReferences ? "当前已经有资料可吸收，可以先提炼规则和冲突来源。" : "建议先在左侧资料区上传 txt / md / html，再执行资料吸收。");
      break;
    case "generate_setting":
      hints.push("适合项目刚启动，或人物卡、世界观、势力关系还不完整的时候执行。");
      break;
    case "generate_outline":
      hints.push("建议在设定已经回填后执行，这样卷纲和主链目标更稳定。");
      break;
    case "generate_chapter":
      hints.push(options.hasActiveChapter ? "当前已有活动章节，系统会优先围绕这一章继续生成。" : "章节生成前需要先有活动章节；可先切到正文写作模式创建章节。");
      break;
    case "review_content":
      hints.push("审稿输出固定为“问题 -> 证据 -> 最小修法”，适合在正文初稿后立即执行。");
      break;
    case "minimal_fix":
      hints.push("建议先有一份最新审稿结果，再按最小范围修改，避免整章漂移。");
      break;
    case "research_fact_check":
      hints.push("考据只补现实事实和资料来源，不会直接覆盖剧情正式稿。");
      break;
    case "sync_state":
      hints.push("适合在接受正文、审稿或资料吸收结果后执行，用来更新状态卡和进度。");
      break;
    default:
      hints.push("如果当前主链没卡住，可以直接推进这一环。");
      break;
  }

  if (taskConfig.requiredArtifacts.length > 0) {
    hints.push(`系统会自动优先装配 ${taskConfig.requiredArtifacts.length} 类关键项目文件。`);
  }

  if (taskConfig.supportsMcp || taskConfig.supportsSearch) {
    hints.push(
      [
        taskConfig.supportsMcp ? "可勾选 MCP 增强" : null,
        taskConfig.supportsSearch ? "可补外部事实" : null,
      ]
        .filter(Boolean)
        .join(" / "),
    );
  }

  return hints;
}

function appendUniqueArtifacts(artifacts: ArtifactItem[]) {
  const seen = new Set<string>();

  return artifacts.filter((artifact) => {
    if (seen.has(artifact.id)) {
      return false;
    }

    seen.add(artifact.id);
    return true;
  });
}

function buildTaskContextArtifacts(
  artifacts: ArtifactItem[],
  taskType: TaskType,
  extraArtifacts: ArtifactItem[] = [],
) {
  const taskConfig = TASK_CONFIG_BY_TYPE.get(taskType);
  const requiredArtifacts = artifacts.filter((artifact) => taskConfig?.requiredArtifacts.includes(artifact.artifactKey));

  return appendUniqueArtifacts([...requiredArtifacts, ...extraArtifacts]);
}

function draftTouchesArtifact(draft: DraftItem, artifactId: string | null | undefined) {
  if (!artifactId) {
    return false;
  }

  if (draft.artifactId === artifactId) {
    return true;
  }

  return normalizeResolvedArtifacts(draft.run?.resolvedContextArtifacts).some((artifact) => artifact.id === artifactId);
}

export function WorkbenchRunConsole({ project, mode }: WorkbenchRunConsoleProps) {
  const router = useRouter();
  const apiPresets = useMemo(() => normalizeApiPresets(project.preference?.apiPresets), [project.preference?.apiPresets]);
  const [activeApiPresetKey, setActiveApiPresetKey] = useState<ApiPresetKey | "manual">("manual");
  const [taskType, setTaskType] = useState(project.preference?.defaultTaskType ?? "generate_chapter");
  const [userInstruction, setUserInstruction] = useState(buildDefaultInstruction(project.preference?.defaultTaskType ?? "generate_chapter"));
  const [endpointId, setEndpointId] = useState(project.preference?.defaultEndpointId ?? project.providerEndpoints[0]?.id ?? "");
  const [modelId, setModelId] = useState(project.preference?.defaultModel ?? "");
  const [temperature, setTemperature] = useState("0.7");
  const [maxTokens, setMaxTokens] = useState("1200");
  const [requireExternalFacts, setRequireExternalFacts] = useState(false);
  const [chapterGenerationMode, setChapterGenerationMode] = useState<"direct" | "guided">("direct");
  const [chapterGuidanceAnswer, setChapterGuidanceAnswer] = useState("");
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<string[]>([]);
  const [selectedReferenceIds, setSelectedReferenceIds] = useState<string[]>([]);
  const [selectedMcpServerIds, setSelectedMcpServerIds] = useState<string[]>([]);
  const [appliedPromptTemplate, setAppliedPromptTemplate] = useState<AppliedMcpPromptTemplate | null>(null);
  const [latestRun, setLatestRun] = useState<LatestRunState | null>(null);
  const [isStreamingRun, setIsStreamingRun] = useState(false);
  const [streamingOutput, setStreamingOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [activeDraftAction, setActiveDraftAction] = useState<string | null>(null);
  const [acceptTargets, setAcceptTargets] = useState<Record<string, string>>({});
  const [acceptSummaries, setAcceptSummaries] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();

  const selectedEndpoint = useMemo(
    () => project.providerEndpoints.find((endpoint) => endpoint.id === endpointId) ?? null,
    [endpointId, project.providerEndpoints],
  );
  const chapterArtifacts = useMemo(
    () =>
      project.artifacts
        .filter((artifact) => artifact.kind === "project_chapter")
        .map((artifact) => {
          const chapterMeta = project.chapterIndex.find((entry) => entry.artifactId === artifact.id);

          return {
            artifactId: artifact.id,
            artifactKey: artifact.artifactKey,
            filename: artifact.filename,
            chapterNumber: chapterMeta?.chapterNumber ?? artifact.artifactKey,
            title: chapterMeta?.title ?? artifact.filename.replace(/\.md$/, ""),
            status: chapterMeta?.status ?? "draft",
            wordCount: chapterMeta?.wordCount ?? countNovelWords(artifact.currentRevision?.content),
            updatedAt: chapterMeta?.updatedAt ?? null,
            currentRevisionContent: artifact.currentRevision?.content ?? "",
          };
        }),
    [project.artifacts, project.chapterIndex],
  );
  const activeChapterArtifact = useMemo(
    () =>
      project.artifacts.find((artifact) => artifact.id === project.activeChapterArtifactId) ??
      project.artifacts.find((artifact) => artifact.kind === "project_chapter") ??
      null,
    [project.activeChapterArtifactId, project.artifacts],
  );
  const taskConfig = useMemo(
    () => TASK_CONFIGS.find((item) => item.taskType === taskType) ?? TASK_CONFIGS[0],
    [taskType],
  );
  const taskOperatorHints = useMemo(
    () =>
      buildTaskOperatorHints(taskConfig, {
        hasReferences: project.references.length > 0,
        hasActiveChapter: Boolean(activeChapterArtifact),
      }),
    [activeChapterArtifact, project.references.length, taskConfig],
  );
  const autoContextArtifacts = useMemo(
    () => project.artifacts.filter((artifact) => taskConfig.requiredArtifacts.includes(artifact.artifactKey)),
    [project.artifacts, taskConfig.requiredArtifacts],
  );
  const effectiveContextArtifacts = useMemo(() => {
    const selectedSet = new Set(selectedArtifactIds);
    const manuallySelectedArtifacts = project.artifacts.filter((artifact) => selectedSet.has(artifact.id));

    return appendUniqueArtifacts([
      ...autoContextArtifacts,
      ...manuallySelectedArtifacts,
      ...(taskType === "generate_chapter" && activeChapterArtifact ? [activeChapterArtifact] : []),
    ]);
  }, [activeChapterArtifact, autoContextArtifacts, project.artifacts, selectedArtifactIds, taskType]);
  const selectedReferenceNames = useMemo(
    () =>
      project.references
        .filter((reference) => selectedReferenceIds.includes(reference.id))
        .map((reference) => reference.filename),
    [project.references, selectedReferenceIds],
  );
  const selectedMcpNames = useMemo(
    () => project.mcpServers.filter((server) => selectedMcpServerIds.includes(server.id)).map((server) => server.name),
    [project.mcpServers, selectedMcpServerIds],
  );
  const selectedArtifactNames = useMemo(
    () =>
      effectiveContextArtifacts.map((artifact) => getArtifactDisplayName(artifact.artifactKey, artifact.filename)),
    [effectiveContextArtifacts],
  );
  const activeChapter = useMemo(
    () => chapterArtifacts.find((chapter) => chapter.artifactId === activeChapterArtifact?.id) ?? chapterArtifacts[0] ?? null,
    [activeChapterArtifact?.id, chapterArtifacts],
  );
  const activeChapterSourceContent = useMemo(
    () => project.editorAutosaveDraft?.outputContent ?? activeChapter?.currentRevisionContent ?? "",
    [activeChapter?.currentRevisionContent, project.editorAutosaveDraft?.outputContent],
  );
  const chapterGuidancePrompt = useMemo(
    () =>
      buildChapterGuidancePrompt({
        projectName: project.name,
        genre: project.genre,
        platform: project.platform,
        chapterTitle: activeChapter?.title ?? activeChapterArtifact?.filename ?? "当前章节",
        chapterContent: activeChapterSourceContent,
        currentState:
          project.artifacts.find((artifact) => artifact.artifactKey === "current_state_card")?.currentRevision?.content ?? "",
        taskPlan: project.artifacts.find((artifact) => artifact.artifactKey === "task_plan")?.currentRevision?.content ?? "",
        pendingHooks:
          project.artifacts.find((artifact) => artifact.artifactKey === "pending_hooks")?.currentRevision?.content ?? "",
        findings: project.artifacts.find((artifact) => artifact.artifactKey === "findings")?.currentRevision?.content ?? "",
      }),
    [activeChapter?.title, activeChapterArtifact?.filename, activeChapterSourceContent, project.artifacts, project.genre, project.name, project.platform],
  );
  const chapterGuidanceBrief = useMemo(
    () =>
      buildChapterGuidanceBrief({
        chapterTitle: activeChapter?.title ?? activeChapterArtifact?.filename ?? "当前章节",
        guidanceAnswer: chapterGuidanceAnswer,
      }),
    [activeChapter?.title, activeChapterArtifact?.filename, chapterGuidanceAnswer],
  );
  const latestReviewDraft = useMemo(
    () =>
      project.drafts.find(
        (draft) =>
          draft.taskType === "review_content" &&
          draft.status !== "rejected" &&
          draftTouchesArtifact(draft, activeChapter?.artifactId),
      ) ?? null,
    [activeChapter?.artifactId, project.drafts],
  );
  const latestMinimalFixDraft = useMemo(
    () =>
      project.drafts.find(
        (draft) =>
          draft.taskType === "minimal_fix" &&
          draft.status !== "rejected" &&
          draft.artifactId === activeChapter?.artifactId,
      ) ?? null,
    [activeChapter?.artifactId, project.drafts],
  );
  const isTaskMode = mode === "task";
  const isWritingMode = mode === "writing";
  const isReviewMode = mode === "review";

  useEffect(() => {
    if (!endpointId && project.providerEndpoints[0]) {
      setEndpointId(project.providerEndpoints[0].id);
      return;
    }

    if (!selectedEndpoint) {
      return;
    }

    if (!modelId.trim()) {
      setModelId(project.preference?.defaultModel ?? selectedEndpoint.defaultModel);
    }
  }, [endpointId, modelId, project.preference?.defaultModel, project.providerEndpoints, selectedEndpoint]);

  useEffect(() => {
    if (taskType !== "generate_chapter") {
      setChapterGenerationMode("direct");
      setChapterGuidanceAnswer("");
    }
  }, [taskType]);

  useEffect(() => {
    if (activeApiPresetKey === "manual") {
      return;
    }

    if (!apiPresets.some((preset) => preset.presetKey === activeApiPresetKey)) {
      setActiveApiPresetKey("manual");
    }
  }, [activeApiPresetKey, apiPresets]);

  function applyApiPreset(preset: ApiPreset) {
    const nextState = buildAppliedApiPresetState(preset, {
      fallbackEndpointId: project.providerEndpoints[0]?.id,
      buildInstruction: buildDefaultInstruction,
    });

    setActiveApiPresetKey(nextState.activeApiPresetKey);
    setEndpointId(nextState.endpointId);
    setModelId(nextState.modelId);
    setTaskType(nextState.taskType);
    setUserInstruction(nextState.userInstruction);
    setTemperature(nextState.temperature);
    setMaxTokens(nextState.maxTokens);
  }

  function toggleSelection(id: string, selectedIds: string[], setter: (next: string[]) => void) {
    setter(selectedIds.includes(id) ? selectedIds.filter((item) => item !== id) : [...selectedIds, id]);
  }

  async function submitGenerate(
    overrides?: Partial<{
      taskType: string;
      userInstruction: string;
      targetArtifactId: string;
      selectedArtifactIds: string[];
      selectedReferenceIds: string[];
      selectedMcpServerIds: string[];
      requireExternalFacts: boolean;
      externalPromptTemplate: AppliedMcpPromptTemplate | null;
    }>,
  ) {
    setError(null);
    setMessage(null);

    const nextTaskType = overrides?.taskType ?? taskType;
    const nextInstruction = overrides?.userInstruction ?? userInstruction;
    const nextTargetArtifactId = overrides?.targetArtifactId;
    const nextSelectedArtifactIds = overrides?.selectedArtifactIds ?? selectedArtifactIds;
    const nextSelectedReferenceIds = overrides?.selectedReferenceIds ?? selectedReferenceIds;
    const nextSelectedMcpServerIds = overrides?.selectedMcpServerIds ?? selectedMcpServerIds;
    const nextRequireExternalFacts = overrides?.requireExternalFacts ?? requireExternalFacts;
    const nextExternalPromptTemplate = overrides?.externalPromptTemplate ?? appliedPromptTemplate;

    if ((nextTaskType === "generate_chapter" || nextTaskType === "minimal_fix") && !nextTargetArtifactId) {
      throw new Error("当前还没有可写入的章节，请先在正文编辑器里创建章节。");
    }

    const effectiveInstruction =
      nextTaskType === "generate_chapter" && chapterGenerationMode === "guided"
        ? buildChapterGuidanceRunInstruction({
            baseInstruction: nextInstruction,
            chapterTitle: activeChapter?.title ?? activeChapterArtifact?.filename ?? "当前章节",
            guidanceAnswer: chapterGuidanceAnswer,
          })
        : nextInstruction;

    const response = await fetch(`/api/projects/${project.id}/generate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/x-ndjson, application/json",
      },
      body: JSON.stringify({
        taskType: nextTaskType,
        userInstruction: effectiveInstruction,
        endpointId,
        modelId,
        targetArtifactId: nextTargetArtifactId,
        selectedArtifactIds: nextSelectedArtifactIds,
        selectedReferenceIds: nextSelectedReferenceIds,
        selectedMcpServerIds: nextSelectedMcpServerIds,
        generationOptions: {
          temperature: temperature.trim() ? Number(temperature) : undefined,
          maxTokens: maxTokens.trim() ? Number(maxTokens) : undefined,
          requireExternalFacts: nextRequireExternalFacts,
          externalPromptTemplate: nextExternalPromptTemplate ?? undefined,
        },
      }),
    });

    const contentType = response.headers.get("content-type") ?? "";

    if (contentType.includes("application/x-ndjson")) {
      if (!response.ok) {
        throw new Error("流式生成启动失败。");
      }

      await consumeGenerateStream(response);
      return;
    }

    const payload = (await response.json().catch(() => null)) as unknown;

    if (!response.ok) {
      throw new Error(readErrorMessage(payload));
    }

    const nextRun = parseLatestRunState(payload);
    if (!nextRun) {
      throw new Error("生成返回格式不正确。");
    }

    setLatestRun(nextRun);
    setMessage("生成成功，草稿已写入结果面板。");
    router.refresh();
  }

  async function consumeGenerateStream(response: Response) {
    if (!response.body) {
      throw new Error("未收到流式响应体。");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completedPayload: unknown = null;
    let streamError: string | null = null;

    setIsStreamingRun(true);
    setStreamingOutput("");
    setMessage("正在流式生成，请等待完成。");

    async function handleLine(line: string) {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new Error("流式生成返回了无法解析的事件。");
      }

      const event = parseGenerateStreamEvent(parsed);
      if (!event) {
        return;
      }

      switch (event.type) {
        case "started":
          setMessage("模型已开始返回内容。");
          break;
        case "text-delta":
          setStreamingOutput((current) => current + event.text);
          break;
        case "completed":
          completedPayload = event.payload;
          break;
        case "error":
          streamError = readErrorMessage({
            error: {
              code: event.error.code,
              message: event.error.message ?? "流式生成失败。",
              details: event.error.details,
            },
          });
          break;
      }
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          await handleLine(line);
        }
      }

      const tail = `${buffer}${decoder.decode()}`.trim();
      if (tail) {
        await handleLine(tail);
      }
    } finally {
      reader.releaseLock();
      setIsStreamingRun(false);
    }

    if (streamError) {
      setStreamingOutput("");
      throw new Error(streamError);
    }

    const nextRun = parseLatestRunState(completedPayload);
    if (!nextRun) {
      setStreamingOutput("");
      throw new Error("流式生成已结束，但没有收到完整结果。");
    }

    setLatestRun(nextRun);
    setStreamingOutput("");
    setMessage("生成成功，草稿已写入结果面板。");
    router.refresh();
  }

  async function submitReviewDraft(reviewInstruction: string) {
    const reviewArtifacts = buildTaskContextArtifacts(project.artifacts, "review_content", activeChapterArtifact ? [activeChapterArtifact] : []);

    await submitGenerate({
      taskType: "review_content",
      userInstruction: reviewInstruction,
      selectedArtifactIds: reviewArtifacts.map((artifact) => artifact.id),
      selectedReferenceIds,
      selectedMcpServerIds,
      requireExternalFacts,
    });
  }

  async function submitMinimalFixDraft(minimalFixInstruction: string, reviewContext?: string) {
    if (!activeChapterArtifact) {
      throw new Error("当前没有活动章节，无法生成最小修法。");
    }

    if (!latestReviewDraft) {
      throw new Error("请先生成审稿结果，再执行最小修法。");
    }

    const minimalFixArtifacts = buildTaskContextArtifacts(project.artifacts, "minimal_fix", [
      activeChapterArtifact,
      ...filterArtifactsByKeys(project.artifacts, ["current_state_card", "findings"]),
    ]);
    const reviewContextInstruction = [
      minimalFixInstruction.trim(),
      "",
      "请严格根据以下最新审稿意见执行最小修法：",
      reviewContext?.trim() || latestReviewDraft.outputContent,
    ]
      .join("\n")
      .trim();

    await submitGenerate({
      taskType: "minimal_fix",
      userInstruction: reviewContextInstruction,
      targetArtifactId: activeChapterArtifact.id,
      selectedArtifactIds: minimalFixArtifacts.map((artifact) => artifact.id),
      selectedReferenceIds,
    });
  }

  async function acceptDraft(draft: DraftItem) {
    const candidates = buildDraftArtifactCandidates(draft, project.artifacts);
    const selectedArtifactId = acceptTargets[draft.id] ?? candidates[0]?.id;
    const selectedArtifact = candidates.find((artifact) => artifact.id === selectedArtifactId) ?? candidates[0];
    const summary = acceptSummaries[draft.id]?.trim() || buildDefaultAcceptSummary(draft, selectedArtifact);

    if (!selectedArtifactId) {
      throw new Error("当前草稿没有可回填的目标文件。");
    }

    const response = await fetch(`/api/projects/${project.id}/drafts/${draft.id}/accept`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        artifactId: selectedArtifactId,
        summary,
      }),
    });

    const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!response.ok) {
      throw new Error(readErrorMessage(payload));
    }

    setMessage("草稿已接受并回填。");
    router.refresh();
  }

  async function rejectDraft(draft: DraftItem) {
    const response = await fetch(`/api/projects/${project.id}/drafts/${draft.id}/reject`, {
      method: "POST",
    });

    const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!response.ok) {
      throw new Error(readErrorMessage(payload));
    }

    setMessage("草稿已标记为放弃。");
    router.refresh();
  }

  return (
    <>
      <div className="space-y-5">
        {isTaskMode ? (
          <SectionPanel
            title={project.name}
            description={`${project.genre} · ${project.platform} · 草稿优先工作流`}
            className="editor-column"
            action={
              <ButtonLink href="/projects" variant="ghost" size="sm">
                返回项目列表
              </ButtonLink>
            }
          >
            <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
              <div className="space-y-4">
                <div>
                  <label className="mb-2 block text-sm text-[var(--muted-ink)]">任务</label>
                  <Select
                    value={taskType}
                    onChange={(event) => {
                      const nextTaskType = event.target.value;
                      setActiveApiPresetKey("manual");
                      setTaskType(nextTaskType);
                      if (userInstruction === buildDefaultInstruction(taskType)) {
                        setUserInstruction(buildDefaultInstruction(nextTaskType));
                      }
                    }}
                  >
                    {TASK_TYPES.map((item) => (
                      <option key={item} value={item}>
                        {getTaskDisplayLabel(item)}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="rounded-[24px] border border-[var(--line)] bg-[rgba(255,248,238,0.72)] p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className="bg-[rgba(85,109,89,0.12)] text-[#556d59]">{taskConfig.label}</Badge>
                    {taskConfig.supportsMcp ? <Badge className="bg-[rgba(64,83,102,0.08)] text-[#405366]">支持 MCP</Badge> : null}
                    {taskConfig.supportsSearch ? <Badge className="bg-[rgba(191,152,69,0.10)] text-[#7f5f1d]">支持外部事实</Badge> : null}
                  </div>
                  <p className="mt-3 text-sm leading-6 text-[var(--ink-soft)]">{taskConfig.description}</p>
                  <ul className="mt-3 space-y-2 text-sm leading-6 text-[var(--ink-soft)]">
                    {taskOperatorHints.map((hint) => (
                      <li key={hint}>- {hint}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <label className="mb-2 block text-sm text-[var(--muted-ink)]">用户指令</label>
                  <Textarea value={userInstruction} onChange={(event) => setUserInstruction(event.target.value)} />
                </div>
                {taskType === "generate_chapter" ? (
                  <div className="rounded-[24px] border border-[var(--line)] bg-[rgba(255,248,238,0.72)] p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm text-[var(--ink)]">章节推进方式</p>
                        <p className="mt-1 text-xs leading-6 text-[var(--muted-ink)]">
                          直接生成会沿用当前状态；引导式推进会先让你选一次本章推进重点，再把场景 brief 拼进本次 run。
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 rounded-[24px] bg-[var(--paper)] p-1">
                        <Button
                          type="button"
                          size="sm"
                          variant={chapterGenerationMode === "direct" ? "default" : "ghost"}
                          onClick={() => setChapterGenerationMode("direct")}
                        >
                          直接生成
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={chapterGenerationMode === "guided" ? "default" : "ghost"}
                          onClick={() => setChapterGenerationMode("guided")}
                        >
                          引导式推进
                        </Button>
                      </div>
                    </div>

                    {chapterGenerationMode === "guided" ? (
                      <div className="mt-4 space-y-4 rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4">
                        <div>
                          <p className="text-xs tracking-[0.16em] text-[var(--muted-ink)] uppercase">本章问题</p>
                          <p className="mt-2 text-sm leading-7 text-[var(--ink)]">{chapterGuidancePrompt.question}</p>
                          <p className="mt-2 text-xs leading-6 text-[var(--muted-ink)]">{chapterGuidancePrompt.hint}</p>
                        </div>

                        <div className="grid gap-3 md:grid-cols-2">
                          {chapterGuidancePrompt.options.map((option) => (
                            <button
                              key={option.label}
                              type="button"
                              className="rounded-[18px] border border-[var(--line)] bg-[rgba(255,255,255,0.72)] p-4 text-left transition hover:border-[var(--ring)]"
                              onClick={() => setChapterGuidanceAnswer(option.value)}
                            >
                              <p className="text-sm text-[var(--ink)]">{option.label}</p>
                              <p className="mt-2 text-xs leading-6 text-[var(--muted-ink)]">{previewText(option.value, 96)}</p>
                            </button>
                          ))}
                        </div>

                        <div>
                          <label className="mb-2 block text-sm text-[var(--muted-ink)]">你的本章推进选择</label>
                          <Textarea
                            value={chapterGuidanceAnswer}
                            onChange={(event) => setChapterGuidanceAnswer(event.target.value)}
                            placeholder="可以直接点推荐项，也可以自己写一句更贴合本章的推进方向。"
                          />
                        </div>

                        <div className="rounded-[18px] border border-dashed border-[var(--line)] bg-[rgba(255,252,246,0.88)] p-4">
                          <p className="text-xs tracking-[0.16em] text-[var(--muted-ink)] uppercase">本次 scene brief</p>
                          <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-[var(--ink-soft)]">
                            {chapterGuidanceBrief || "如果这里留空，系统就按当前状态卡、卷纲、伏笔和活动章节继续直接生成。"}
                          </p>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {appliedPromptTemplate ? (
                  <div className="rounded-[20px] border border-[var(--line)] bg-[rgba(255,248,238,0.72)] p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm text-[var(--ink)]">外部提示模板</p>
                        <p className="mt-1 text-xs text-[var(--muted-ink)]">
                          {appliedPromptTemplate.serverName} / {appliedPromptTemplate.promptName}
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => setAppliedPromptTemplate(null)}
                      >
                        清除
                      </Button>
                    </div>
                    <pre className="mt-3 whitespace-pre-wrap text-xs leading-6 text-[var(--ink-soft)]">
                      {previewText(appliedPromptTemplate.content, 260)}
                    </pre>
                  </div>
                ) : null}

                <div className="rounded-[24px] border border-[var(--line)] bg-[var(--paper)] p-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <p className="text-sm text-[var(--ink)]">项目文件上下文</p>
                    <span className="text-xs text-[var(--muted-ink)]">
                      {selectedArtifactIds.length > 0 ? `${selectedArtifactIds.length} 已勾选` : "按任务自动装配"}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {project.artifacts.map((artifact) => (
                      <label
                        key={artifact.id}
                        className="flex items-start gap-3 rounded-[18px] border border-[var(--line)] px-3 py-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={selectedArtifactIds.includes(artifact.id)}
                          onChange={() => toggleSelection(artifact.id, selectedArtifactIds, setSelectedArtifactIds)}
                          className="mt-1 h-4 w-4 accent-[var(--accent)]"
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-[var(--ink)]">
                            {getArtifactDisplayLabel(artifact.artifactKey, artifact.filename)}
                          </span>
                          <span className="text-xs text-[var(--muted-ink)]">{artifact.filename}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                  <p className="mt-3 text-xs leading-6 text-[var(--muted-ink)]">
                    默认装配：
                    {" "}
                    {autoContextArtifacts.length > 0
                      ? autoContextArtifacts
                          .map((artifact) => getArtifactDisplayName(artifact.artifactKey, artifact.filename))
                          .join(" / ")
                      : "当前任务没有默认项目文件。"}
                  </p>
                  <p className="mt-2 text-xs leading-6 text-[var(--muted-ink)]">
                    勾选过多项目文件时，系统会自动按文件与标题分段压缩；超预算时才继续截断或跳过，避免模型上下文过载。
                  </p>
                </div>

                <div className="rounded-[24px] border border-[var(--line)] bg-[var(--paper)] p-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <p className="text-sm text-[var(--ink)]">引用资料</p>
                    <span className="text-xs text-[var(--muted-ink)]">{selectedReferenceIds.length} 已勾选</span>
                  </div>
                  <div className="space-y-2">
                    {project.references.length === 0 ? (
                      <p className="text-sm text-[var(--muted-ink)]">还没有上传资料，可先去左侧资料区导入。</p>
                    ) : (
                      project.references.map((reference) => (
                        <label key={reference.id} className="flex items-start gap-3 rounded-[18px] border border-[var(--line)] px-3 py-2 text-sm">
                          <input
                            type="checkbox"
                            checked={selectedReferenceIds.includes(reference.id)}
                            onChange={() => toggleSelection(reference.id, selectedReferenceIds, setSelectedReferenceIds)}
                            className="mt-1 h-4 w-4 accent-[var(--accent)]"
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-[var(--ink)]">{reference.filename}</span>
                            <span className="text-xs text-[var(--muted-ink)]">
                              {reference.sourceType} · {previewText(reference.normalizedText ?? reference.extractedText, 70)}
                            </span>
                          </span>
                        </label>
                      ))
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3 rounded-[24px] border border-[var(--line)] bg-[rgba(255,255,255,0.54)] p-4">
                  <label className="flex items-center gap-3 text-sm text-[var(--ink-soft)]">
                    <input
                      type="checkbox"
                      checked={requireExternalFacts}
                      onChange={(event) => setRequireExternalFacts(event.target.checked)}
                      className="h-4 w-4 accent-[var(--accent)]"
                    />
                    需要外部事实补充
                  </label>
                  <Button
                    type="button"
                    disabled={
                      isPending ||
                      !endpointId ||
                      !modelId.trim() ||
                      !userInstruction.trim() ||
                      ((taskType === "generate_chapter" || taskType === "minimal_fix") && !activeChapterArtifact)
                    }
                    onClick={() =>
                      startTransition(async () => {
                        try {
                          await submitGenerate({
                            targetArtifactId:
                              taskType === "generate_chapter" || taskType === "minimal_fix"
                                ? activeChapterArtifact?.id
                                : undefined,
                          });
                        } catch (submitError) {
                          setError(submitError instanceof Error ? submitError.message : "生成失败。");
                        }
                      })
                    }
                  >
                    {isPending ? "生成中" : "生成草稿"}
                  </Button>
                </div>

                {(taskType === "generate_chapter" || taskType === "minimal_fix") && !activeChapterArtifact ? (
                  <p className="text-xs leading-6 text-[var(--muted-ink)]">
                    当前没有活动章节。请先在正文编辑器里创建章节，再执行正文相关生成。
                  </p>
                ) : null}

                {error ? <p className="whitespace-pre-wrap text-sm text-[#9f3a2f]">{error}</p> : null}
                {message ? <p className="text-sm text-[#556d59]">{message}</p> : null}
              </div>

              <div className="rounded-[24px] border border-[var(--line)] bg-[rgba(255,255,255,0.54)] p-4 text-sm leading-7 text-[var(--ink-soft)]">
                <p className="text-xs tracking-[0.22em] text-[var(--muted-ink)] uppercase">本次装配</p>
                <ul className="mt-3 space-y-2">
                  <li>任务：{taskConfig.label}</li>
                  <li>提示模板：<code>{getPromptTemplateLabel(taskConfig.promptFile)}</code></li>
                  <li>规则组合：{taskConfig.skills.length > 0 ? taskConfig.skills.map((skill) => getSkillDisplayLabel(skill)).join(" / ") : "无"}</li>
                  <li>
                    API 预设：
                    {" "}
                    {activeApiPresetKey === "manual"
                      ? "手动配置"
                      : apiPresets.find((preset) => preset.presetKey === activeApiPresetKey)?.label ?? "手动配置"}
                  </li>
                  <li>模型接口：<code>{selectedEndpoint?.label ?? "未配置"}</code></li>
                  <li>模型：<code>{modelId || "未填写"}</code></li>
                  {taskType === "generate_chapter" || taskType === "minimal_fix" ? (
                    <li>目标章节：<code>{activeChapterArtifact?.filename ?? "未创建章节"}</code></li>
                  ) : null}
                  {taskType === "generate_chapter" ? (
                    <li>章节推进：{chapterGenerationMode === "guided" ? "引导式推进" : "直接生成"}</li>
                  ) : null}
                  {taskType === "generate_chapter" && chapterGenerationMode === "guided" ? (
                    <li>本章摘要：{chapterGuidanceBrief ? previewText(chapterGuidanceBrief, 96) : "未填写，回退到现有上下文"}</li>
                  ) : null}
                  <li>引用资料：{selectedReferenceNames.length > 0 ? selectedReferenceNames.join(" / ") : "未勾选"}</li>
                  <li>MCP：{selectedMcpNames.length > 0 ? selectedMcpNames.join(" / ") : "未勾选"}</li>
                  <li>
                    外部模板：
                    {" "}
                    {appliedPromptTemplate
                      ? `${appliedPromptTemplate.serverName} / ${appliedPromptTemplate.promptName}`
                      : "未选择"}
                  </li>
                  <li>
                    项目文件：
                    {" "}
                    {latestRun?.resolvedArtifacts.length
                      ? latestRun.resolvedArtifacts
                          .map((artifact) => getArtifactDisplayName(artifact.artifactKey, artifact.filename))
                          .join(" / ")
                      : selectedArtifactNames.length > 0
                        ? selectedArtifactNames.join(" / ")
                        : "按任务自动装配"}
                  </li>
                  <li>输出要求：{taskConfig.outputContract}</li>
                </ul>

                {isStreamingRun ? (
                  <div className="mt-4 space-y-3">
                    <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-3">
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-xs tracking-[0.14em] text-[var(--muted-ink)] uppercase">实时输出</p>
                        <Badge className="bg-[rgba(85,109,89,0.12)] text-[#556d59]">流式生成中</Badge>
                      </div>
                      <pre className="mt-2 whitespace-pre-wrap text-sm leading-7 text-[var(--ink-soft)]">
                        {streamingOutput.trim() ? streamingOutput : "正在等待模型返回首段内容..."}
                      </pre>
                    </div>
                  </div>
                ) : null}

                {latestRun ? (
                  <div className="mt-4 space-y-3">
                    <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-3">
                      <p className="text-xs tracking-[0.14em] text-[var(--muted-ink)] uppercase">最新输出</p>
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-[var(--ink-soft)]">
                        {previewText(latestRun.output, 420)}
                      </p>
                    </div>
                    <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-3">
                      <p className="text-xs tracking-[0.14em] text-[var(--muted-ink)] uppercase">最终规则组合</p>
                      <p className="mt-2 text-sm text-[var(--ink-soft)]">
                        {latestRun.resolvedSkills.length > 0 ? latestRun.resolvedSkills.join(" / ") : "无"}
                      </p>
                    </div>
                    <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs tracking-[0.14em] text-[var(--muted-ink)] uppercase">大结果归档</p>
                          <p className="mt-2 text-sm leading-7 text-[var(--ink-soft)]">
                            {latestRun.archiveDownloadUrl
                              ? `${latestRun.archiveObjectStoreMode === "s3" ? "对象存储" : "本地归档"} · ${formatByteSize(latestRun.archiveByteSize)}`
                              : "本次输出没有达到完整归档阈值，结果仍可在草稿和运行记录里查看。"}
                          </p>
                        </div>
                        {latestRun.archiveDownloadUrl ? (
                          <ButtonLink href={latestRun.archiveDownloadUrl} variant="secondary" size="sm">
                            下载归档
                          </ButtonLink>
                        ) : (
                          <Badge className="bg-[rgba(64,83,102,0.08)] text-[#405366]">未触发归档</Badge>
                        )}
                      </div>
                    </div>
                    <RunDiagnosticsSummary projectId={project.id} toolCallsSummary={latestRun.toolCallsSummary} />
                    <details className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-3">
                      <summary className="cursor-pointer text-xs tracking-[0.14em] text-[var(--muted-ink)] uppercase">
                        查看最终装配提示词
                      </summary>
                      <pre className="mt-3 whitespace-pre-wrap text-xs leading-6 text-[var(--ink-soft)]">{latestRun.resolvedPrompt}</pre>
                    </details>
                  </div>
                ) : null}
              </div>
            </div>
          </SectionPanel>
        ) : null}

        {isWritingMode ? (
          <>
            <SectionPanel
              title={`${project.name} · 正文写作`}
              description="正文模式只保留章节编辑和状态聚焦；需要重新装配任务时，切回“任务执行”。"
              action={
                <ButtonLink href={`/projects/${project.id}?mode=task`} variant="secondary" size="sm">
                  切回任务执行
                </ButtonLink>
              }
            >
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4">
                  <p className="text-xs tracking-[0.14em] text-[var(--muted-ink)] uppercase">活动章节</p>
                  <p className="mt-2 text-sm text-[var(--ink)]">{activeChapter?.title ?? "还没有章节"}</p>
                </div>
                <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4">
                  <p className="text-xs tracking-[0.14em] text-[var(--muted-ink)] uppercase">正文基底</p>
                  <p className="mt-2 text-sm text-[var(--ink)]">
                    {project.editorAutosaveDraft?.outputContent ? "优先使用自动保存草稿" : "当前基于正式版本"}
                  </p>
                </div>
                <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4">
                  <p className="text-xs tracking-[0.14em] text-[var(--muted-ink)] uppercase">当前字数</p>
                  <p className="mt-2 text-sm text-[var(--ink)]">{countNovelWords(activeChapterSourceContent)} 字</p>
                </div>
              </div>
            </SectionPanel>

            <NovelEditor
              key={`${project.id}:${project.activeChapterArtifactId ?? "none"}:${project.editorAutosaveDraft?.id ?? "none"}:${project.editorAutosaveDraft?.updatedAt ?? "none"}`}
              projectId={project.id}
              chapters={chapterArtifacts}
              activeChapterArtifactId={project.activeChapterArtifactId}
              autosaveDraft={project.editorAutosaveDraft}
              layoutPrefs={project.editorLayoutPrefs}
            />
          </>
        ) : null}

        {isReviewMode ? (
          <>
            <SectionPanel
              title={`${project.name} · 审阅改稿`}
              description="审阅模式聚焦当前章节的原文、问题证据和最小修法。"
              action={
                <ButtonLink href={`/projects/${project.id}?mode=task`} variant="secondary" size="sm">
                  切回任务执行
                </ButtonLink>
              }
            >
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4">
                  <p className="text-xs tracking-[0.14em] text-[var(--muted-ink)] uppercase">活动章节</p>
                  <p className="mt-2 text-sm text-[var(--ink)]">{activeChapter?.title ?? "还没有章节"}</p>
                </div>
                <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4">
                  <p className="text-xs tracking-[0.14em] text-[var(--muted-ink)] uppercase">最新审稿草稿</p>
                  <p className="mt-2 text-sm text-[var(--ink)]">
                    {latestReviewDraft ? `${getDraftStatusLabel(latestReviewDraft.status)} · ${formatTime(latestReviewDraft.updatedAt)}` : "暂无"}
                  </p>
                </div>
                <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4">
                  <p className="text-xs tracking-[0.14em] text-[var(--muted-ink)] uppercase">最新最小修法</p>
                  <p className="mt-2 text-sm text-[var(--ink)]">
                    {latestMinimalFixDraft ? `${getDraftStatusLabel(latestMinimalFixDraft.status)} · ${formatTime(latestMinimalFixDraft.updatedAt)}` : "暂无"}
                  </p>
                </div>
              </div>
            </SectionPanel>

            <SectionPanel title="审阅改稿器" description="原文、问题证据和最小修法并排出现，并直接进入审稿草稿或修订草稿。">
              <ReviewEditor
                key={`${project.id}:${activeChapter?.artifactId ?? "none"}:${latestReviewDraft?.id ?? "no-review"}:${latestMinimalFixDraft?.id ?? "no-fix"}`}
                activeChapter={
                  activeChapter
                    ? {
                        artifactId: activeChapter.artifactId,
                        chapterNumber: activeChapter.chapterNumber,
                        title: activeChapter.title,
                        status: activeChapter.status,
                        wordCount: activeChapter.wordCount,
                        updatedAt: activeChapter.updatedAt,
                      }
                    : null
                }
                sourceContent={activeChapterSourceContent}
                usesAutosaveSource={Boolean(project.editorAutosaveDraft?.outputContent)}
                reviewDraft={latestReviewDraft}
                minimalFixDraft={latestMinimalFixDraft}
                onGenerateReview={submitReviewDraft}
                onGenerateMinimalFix={submitMinimalFixDraft}
                onAcceptDraft={acceptDraft}
                onRejectDraft={rejectDraft}
              />
            </SectionPanel>
          </>
        ) : null}
      </div>

      <div className="space-y-5">
        <SectionPanel title="模型面板" description="本次任务的模型接口、模型和采样参数。">
          <div className="space-y-4">
            <div>
              <label className="mb-2 block text-xs tracking-[0.14em] text-[var(--muted-ink)] uppercase">快速切换预设</label>
              <Select
                value={activeApiPresetKey}
                onChange={(event) => {
                  const nextValue = event.target.value as ApiPresetKey | "manual";
                  if (nextValue === "manual") {
                    setActiveApiPresetKey("manual");
                    return;
                  }

                  const preset = apiPresets.find((item) => item.presetKey === nextValue);
                  if (preset) {
                    applyApiPreset(preset);
                  }
                }}
              >
                <option value="manual">手动配置</option>
                {apiPresets.map((preset) => (
                  <option key={preset.presetKey} value={preset.presetKey}>
                    {preset.label} · {getTaskLabel(preset.taskType)}
                  </option>
                ))}
              </Select>
            </div>

            {project.providerEndpoints.length === 0 ? (
              <div className="rounded-[20px] border border-dashed border-[var(--line)] bg-[var(--paper)] p-4 text-sm text-[var(--muted-ink)]">
                还没有可用模型接口。先去 <Link href="/settings" className="underline">设置页</Link> 创建。
              </div>
            ) : (
              <>
                <div>
                  <label className="mb-2 block text-xs tracking-[0.14em] text-[var(--muted-ink)] uppercase">当前模型接口</label>
                  <Select
                    value={endpointId}
                    onChange={(event) => {
                      setActiveApiPresetKey("manual");
                      const nextEndpointId = event.target.value;
                      setEndpointId(nextEndpointId);
                      const nextEndpoint = project.providerEndpoints.find((endpoint) => endpoint.id === nextEndpointId);
                      if (nextEndpoint) {
                        setModelId(nextEndpoint.defaultModel);
                      }
                    }}
                  >
                    {project.providerEndpoints.map((endpoint) => (
                      <option key={endpoint.id} value={endpoint.id}>
                        {endpoint.label} · {getProviderTypeLabel(endpoint.providerType)}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label className="mb-2 block text-xs tracking-[0.14em] text-[var(--muted-ink)] uppercase">模型</label>
                  <Input
                    value={modelId}
                    onChange={(event) => {
                      setActiveApiPresetKey("manual");
                      setModelId(event.target.value);
                    }}
                  />
                </div>
                <div className="grid gap-4 grid-cols-2">
                  <div>
                    <label className="mb-2 block text-xs tracking-[0.14em] text-[var(--muted-ink)] uppercase">随机度</label>
                    <Input
                      value={temperature}
                      onChange={(event) => {
                        setActiveApiPresetKey("manual");
                        setTemperature(event.target.value);
                      }}
                    />
                  </div>
                  <div>
                    <label className="mb-2 block text-xs tracking-[0.14em] text-[var(--muted-ink)] uppercase">最大输出字数</label>
                    <Input
                      value={maxTokens}
                      onChange={(event) => {
                        setActiveApiPresetKey("manual");
                        setMaxTokens(event.target.value);
                      }}
                    />
                  </div>
                </div>
                <p className="text-xs leading-6 text-[var(--muted-ink)]">
                  当前模式：
                  {" "}
                  {activeApiPresetKey === "manual"
                    ? "手动配置"
                    : apiPresets.find((preset) => preset.presetKey === activeApiPresetKey)?.label ?? "手动配置"}
                </p>
                {selectedEndpoint ? (
                  <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4 text-xs leading-6 text-[var(--muted-ink)]">
                    <p>健康状态：{getHealthStatusLabel(selectedEndpoint.healthStatus)}</p>
                    <p className="truncate">URL：{selectedEndpoint.baseURL}</p>
                    <p>最近检查：{formatTime(selectedEndpoint.lastHealthCheckAt)}</p>
                  </div>
                ) : null}
              </>
            )}

            <div className="border-t border-[var(--line)] pt-4">
              <ProjectPreferenceForm
                projectId={project.id}
                preference={project.preference}
                endpoints={project.providerEndpoints}
              />
            </div>
          </div>
        </SectionPanel>

        <SectionPanel title="MCP 面板" description="默认关闭，按任务显式勾选。">
          <McpCapabilityBrowser
            projectId={project.id}
            servers={project.mcpServers}
            selectedServerIds={selectedMcpServerIds}
            onToggleServer={(serverId) => toggleSelection(serverId, selectedMcpServerIds, setSelectedMcpServerIds)}
            appliedPromptTemplate={appliedPromptTemplate}
            onApplyPromptTemplate={setAppliedPromptTemplate}
            disabled={isPending}
          />
        </SectionPanel>

        <SectionPanel title="结果面板" description="候选输出、差异预览、接受并回填统一在这里收口。">
          <div className="space-y-4">
            {project.drafts.length === 0 ? (
              <div className="rounded-[20px] border border-dashed border-[var(--line)] bg-[var(--paper)] p-4 text-sm text-[var(--muted-ink)]">
                还没有草稿结果。先生成一次任务结果。
              </div>
            ) : null}

            {project.drafts.map((draft) => {
              const candidates = buildDraftArtifactCandidates(draft, project.artifacts);
              const requiresExplicitTarget =
                !draft.artifactId &&
                draft.taskType === "generate_chapter" &&
                !project.artifacts.some((artifact) => artifact.kind === "project_chapter");
              const selectedTargetId =
                acceptTargets[draft.id] ??
                draft.artifactId ??
                (requiresExplicitTarget ? "" : candidates[0]?.id ?? "");
              const selectedArtifact =
                candidates.find((artifact) => artifact.id === selectedTargetId) ?? candidates[0] ?? null;
              const summaryValue =
                acceptSummaries[draft.id] ?? buildDefaultAcceptSummary(draft, selectedArtifact ?? undefined);

              return (
                <div key={draft.id} className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm text-[var(--ink)]">{getTaskDisplayLabel(draft.taskType)}</p>
                      <p className="mt-1 text-xs text-[var(--muted-ink)]">
                        {formatTime(draft.updatedAt)} · {getDraftKindLabel(draft.draftKind)}
                      </p>
                    </div>
                    <Badge className={cn(draft.status === "ready" ? "" : "bg-[rgba(85,109,89,0.12)] text-[#556d59]")}>
                      {getDraftStatusLabel(draft.status)}
                    </Badge>
                  </div>

                  <div className="mt-4 grid gap-3 lg:grid-cols-2">
                    <div className="rounded-[18px] border border-[var(--line)] p-3">
                      <p className="text-xs tracking-[0.14em] text-[var(--muted-ink)] uppercase">本次草稿</p>
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-[var(--ink-soft)]">
                        {previewText(draft.outputContent, 280)}
                      </p>
                    </div>
                    <div className="rounded-[18px] border border-[var(--line)] p-3">
                      <p className="text-xs tracking-[0.14em] text-[var(--muted-ink)] uppercase">当前正式稿参考</p>
                      <p className="mt-2 text-sm leading-7 text-[var(--ink-soft)]">
                        {previewText(selectedArtifact?.currentRevision?.content, 280)}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 space-y-3">
                    <div>
                      <label className="mb-2 block text-xs tracking-[0.14em] text-[var(--muted-ink)] uppercase">回填目标</label>
                      <Select
                        value={selectedTargetId}
                        disabled={Boolean(draft.artifactId)}
                        onChange={(event) =>
                          setAcceptTargets((current) => ({
                            ...current,
                            [draft.id]: event.target.value,
                          }))
                        }
                      >
                        {requiresExplicitTarget ? <option value="">请选择回填目标</option> : null}
                        {candidates.map((artifact) => (
                          <option key={artifact.id} value={artifact.id}>
                            {getArtifactDisplayName(artifact.artifactKey, artifact.filename)}
                          </option>
                        ))}
                      </Select>
                    </div>
                    {requiresExplicitTarget ? (
                      <p className="text-xs leading-6 text-[var(--muted-ink)]">
                        当前项目还没有章节文件，接受前请手动确认回填目标，避免把正文写进状态文件。
                      </p>
                    ) : null}
                    {draft.artifactId ? (
                      <p className="text-xs leading-6 text-[var(--muted-ink)]">
                        该草稿已绑定目标章节，接受时会直接回填到对应项目文件。
                      </p>
                    ) : null}
                    <div>
                      <label className="mb-2 block text-xs tracking-[0.14em] text-[var(--muted-ink)] uppercase">回填摘要</label>
                      <Input
                        value={summaryValue}
                        onChange={(event) =>
                          setAcceptSummaries((current) => ({
                            ...current,
                            [draft.id]: event.target.value,
                          }))
                        }
                      />
                    </div>
                    {draft.status === "ready" ? (
                      <div className="flex items-center justify-end gap-3">
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={isPending}
                          onClick={() => {
                            setError(null);
                            setMessage(null);
                            setActiveDraftAction(`reject:${draft.id}`);
                            startTransition(async () => {
                              try {
                                await rejectDraft(draft);
                              } catch (actionError) {
                                setError(actionError instanceof Error ? actionError.message : "放弃草稿失败。");
                              } finally {
                                setActiveDraftAction(null);
                              }
                            });
                          }}
                        >
                          {activeDraftAction === `reject:${draft.id}` ? "处理中" : "放弃结果"}
                        </Button>
                        <Button
                          type="button"
                          disabled={isPending || (requiresExplicitTarget && !selectedTargetId)}
                          onClick={() => {
                            setError(null);
                            setMessage(null);
                            setActiveDraftAction(`accept:${draft.id}`);
                            startTransition(async () => {
                              try {
                                await acceptDraft(draft);
                              } catch (actionError) {
                                setError(actionError instanceof Error ? actionError.message : "接受草稿失败。");
                              } finally {
                                setActiveDraftAction(null);
                              }
                            });
                          }}
                        >
                          {activeDraftAction === `accept:${draft.id}` ? "回填中" : "接受并回填"}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </SectionPanel>
      </div>
    </>
  );
}
