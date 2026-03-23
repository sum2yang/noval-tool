"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { SectionPanel } from "@/components/section-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getProviderTypeLabel } from "@/lib/integrations/display-labels";
import {
  buildBlankGapQuestions,
  buildBlankMaterialDigestInstruction,
  type BlankGapQuestion,
} from "@/lib/projects/blank-onboarding";
import type { OnboardingSessionPayload } from "@/lib/projects/onboarding";

type ProviderEndpointOption = {
  id: string;
  providerType: string;
  label: string;
  defaultModel: string;
  healthStatus: string;
};

type BlankPreparationResult = {
  projectId: string;
  projectName: string;
  importedReferences: Array<{
    id: string;
    filename: string;
  }>;
  usedAiPreparation: boolean;
  endpointLabel: string | null;
  modelId: string | null;
  draftId: string | null;
  output: string | null;
  followUpQuestions: BlankGapQuestion[];
  bootstrapApplied: boolean;
  appliedArtifactKeys: string[];
};

type GuidedSessionEnvelope = {
  session: OnboardingSessionPayload;
};

type GuidedSessionStreamEvent =
  | {
      type: "started";
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

const STANDARD_ARTIFACTS = [
  "story_background.md",
  "world_bible.md",
  "protagonist_card.md",
  "factions_and_characters.md",
  "writing_rules.md",
  "task_plan.md",
  "findings.md",
  "progress.md",
  "character_relationships.md",
  "99_当前状态卡.md",
];
const BLANK_ARTIFACT_LABELS: Record<string, string> = {
  story_background: "故事前提",
  world_bible: "世界规则",
  protagonist_card: "主角卡",
  factions_and_characters: "势力与角色",
  writing_rules: "写作规则",
  task_plan: "任务规划",
  findings: "资料整理记录",
  onboarding_brief: "初始化摘要",
  project_prompt_pack: "项目专属提示词",
  project_skill_pack: "项目专属技能规则",
};

const GUIDED_OVERLAYS = ["onboarding_brief.md", "project_prompt_pack.md", "project_skill_pack.md"];
const BLANK_STEP_TITLES = ["基础资料", "作者材料", "整理方式", "补充关键信息"] as const;
const GUIDED_FOLLOW_UP_HINTS = ["主角目标与核心冲突", "世界规则与禁忌", "势力关系与关键人物", "文风约束与考据边界"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readErrorMessage(payload: unknown) {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }

  return "请求失败。";
}

async function requestJson<T>(input: RequestInfo, init?: RequestInit) {
  const response = await fetch(input, init);
  const payload = (await response.json().catch(() => null)) as T | { error?: { message?: string } } | null;

  if (!response.ok) {
    throw new Error(readErrorMessage(payload));
  }

  return payload as T;
}

function parseGuidedSessionEnvelope(payload: unknown): GuidedSessionEnvelope | null {
  if (!isRecord(payload) || !isRecord(payload.session)) {
    return null;
  }

  return {
    session: payload.session as OnboardingSessionPayload,
  };
}

function parseGuidedSessionStreamEvent(payload: unknown): GuidedSessionStreamEvent | null {
  if (!isRecord(payload) || typeof payload.type !== "string") {
    return null;
  }

  switch (payload.type) {
    case "started":
      return { type: "started" };
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

function getOnboardingStatusLabel(status: OnboardingSessionPayload["status"] | string | null | undefined) {
  switch (status) {
    case "active":
      return "提问中";
    case "ready":
      return "可创建项目";
    case "finalized":
      return "已创建";
    default:
      return "未开始";
  }
}

function getHealthLabel(value: string) {
  switch (value) {
    case "healthy":
      return "健康";
    case "degraded":
      return "降级";
    case "invalid_auth":
      return "鉴权失败";
    case "unreachable":
      return "不可达";
    case "misconfigured":
      return "未配置";
    default:
      return value;
  }
}

function formatFileSize(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function summarizeOptionPreview(value: string) {
  return value.length > 72 ? `${value.slice(0, 72)}...` : value;
}

function getBlankArtifactLabel(key: string) {
  return BLANK_ARTIFACT_LABELS[key] ?? key;
}

export function NewProjectCreator({
  initialMode,
  initialSessionId,
}: {
  initialMode: "blank" | "guided";
  initialSessionId: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [mode, setMode] = useState<"blank" | "guided">(initialMode);

  const [blankStep, setBlankStep] = useState(0);
  const [blankForm, setBlankForm] = useState({
    name: "",
    genre: "",
    platform: "",
    authorNotes: "",
    tags: "",
    prepareWithAi: true,
    endpointId: "",
    modelId: "",
  });
  const [blankFiles, setBlankFiles] = useState<File[]>([]);
  const [providerEndpoints, setProviderEndpoints] = useState<ProviderEndpointOption[]>([]);
  const [endpointError, setEndpointError] = useState<string | null>(null);
  const [blankPending, setBlankPending] = useState(false);
  const [blankError, setBlankError] = useState<string | null>(null);
  const [blankMessage, setBlankMessage] = useState<string | null>(null);
  const [blankResult, setBlankResult] = useState<BlankPreparationResult | null>(null);
  const [blankFollowUpIndex, setBlankFollowUpIndex] = useState(0);
  const [blankFollowUpAnswers, setBlankFollowUpAnswers] = useState<Record<string, string>>({});

  const [sessionId, setSessionId] = useState<string | null>(initialSessionId);
  const [session, setSession] = useState<OnboardingSessionPayload | null>(null);
  const [guidedSeed, setGuidedSeed] = useState({
    name: "",
    genre: "",
    platform: "",
    lengthHint: "",
    era: "",
    keywords: "",
    endpointId: "",
    modelId: "",
  });
  const [guidedAnswer, setGuidedAnswer] = useState("");
  const [guidedPending, setGuidedPending] = useState(false);
  const [guidedStreamingStage, setGuidedStreamingStage] = useState<"create" | "advance" | null>(null);
  const [guidedStreamingOutput, setGuidedStreamingOutput] = useState("");
  const [guidedError, setGuidedError] = useState<string | null>(null);
  const [guidedMessage, setGuidedMessage] = useState<string | null>(null);
  const [finalizeForm, setFinalizeForm] = useState({
    name: "",
    genre: "",
    platform: "",
  });

  const selectedBlankEndpoint = useMemo(
    () => providerEndpoints.find((endpoint) => endpoint.id === blankForm.endpointId) ?? null,
    [blankForm.endpointId, providerEndpoints],
  );
  const selectedGuidedEndpoint = useMemo(
    () => providerEndpoints.find((endpoint) => endpoint.id === guidedSeed.endpointId) ?? null,
    [guidedSeed.endpointId, providerEndpoints],
  );
  const guidedProgressLabel = useMemo(() => {
    if (!session) {
      return "尚未开始";
    }

    return `${Math.min(session.currentQuestionIndex + (session.currentQuestion ? 1 : 0), session.totalQuestions)}/${session.totalQuestions}`;
  }, [session]);
  const guidedPreviewHints = useMemo(() => {
    const combinedSeed = [guidedSeed.genre, guidedSeed.era, guidedSeed.keywords].join(" ");
    if (/(港综|历史|金融|官场|刑侦|赛博|科幻)/.test(combinedSeed)) {
      return [
        "主角目标与核心冲突",
        "世界规则与真实约束",
        "势力关系与关键博弈点",
        "考据边界与写作风格",
      ];
    }

    return [...GUIDED_FOLLOW_UP_HINTS];
  }, [guidedSeed.era, guidedSeed.genre, guidedSeed.keywords]);
  const guidedUsesAi = Boolean(guidedSeed.endpointId && guidedSeed.modelId.trim());
  const guidedStreamingLabel =
    guidedStreamingStage === "create"
      ? "AI 正在生成首问"
      : guidedStreamingStage === "advance"
        ? "AI 正在组织下一问"
        : null;
  const canRunBlankAiPreparation =
    blankForm.prepareWithAi &&
    blankFiles.length > 0 &&
    Boolean(blankForm.endpointId) &&
    Boolean(blankForm.modelId.trim());
  const blankCurrentFollowUpQuestion = blankResult?.followUpQuestions[blankFollowUpIndex] ?? null;

  function syncUrl(nextMode: "blank" | "guided", nextSessionId?: string | null) {
    const params = new URLSearchParams();
    params.set("mode", nextMode);
    if (nextSessionId) {
      params.set("session", nextSessionId);
    }

    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `${pathname}?${params.toString()}`);
    }
  }

  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);

  useEffect(() => {
    setSessionId(initialSessionId);
  }, [initialSessionId]);

  useEffect(() => {
    let cancelled = false;

    async function loadEndpoints() {
      setEndpointError(null);

      try {
        const payload = await requestJson<{ items: ProviderEndpointOption[] }>("/api/provider-endpoints");
        if (cancelled) {
          return;
        }

        const sortedItems = [...payload.items].sort((left, right) => {
          if (left.healthStatus === right.healthStatus) {
            return left.label.localeCompare(right.label, "zh-CN");
          }

          if (left.healthStatus === "healthy") {
            return -1;
          }

          if (right.healthStatus === "healthy") {
            return 1;
          }

          return 0;
        });

        setProviderEndpoints(sortedItems);
      } catch (error) {
        if (!cancelled) {
          setEndpointError(error instanceof Error ? error.message : "加载模型接口失败。");
        }
      }
    }

    void loadEndpoints();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (blankForm.endpointId || providerEndpoints.length === 0) {
      return;
    }

    setBlankForm((current) => ({
      ...current,
      endpointId: providerEndpoints[0].id,
      modelId: providerEndpoints[0].defaultModel,
    }));
  }, [blankForm.endpointId, providerEndpoints]);

  useEffect(() => {
    let cancelled = false;

    async function loadSession(id: string) {
      setGuidedPending(true);
      setGuidedError(null);

      try {
        const payload = await requestJson<{ session: OnboardingSessionPayload }>(
          `/api/projects/bootstrap/session/${id}`,
        );

        if (cancelled) {
          return;
        }

        setSession(payload.session);
        setGuidedAnswer(payload.session.currentQuestion?.answer ?? "");
      } catch (error) {
        if (!cancelled) {
          setGuidedError(error instanceof Error ? error.message : "加载初始化会话失败。");
        }
      } finally {
        if (!cancelled) {
          setGuidedPending(false);
        }
      }
    }

    if (sessionId) {
      void loadSession(sessionId);
    } else {
      setSession(null);
      setGuidedAnswer("");
    }

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!session) {
      return;
    }

    setFinalizeForm((current) => ({
      name: current.name || session.summary.metadata.nameHint || "",
      genre: current.genre || session.summary.metadata.genreHint || "",
      platform: current.platform || session.summary.metadata.platformHint || "",
    }));
  }, [session]);

  function validateBlankStep(step: number) {
    if (step === 0 && (!blankForm.name.trim() || !blankForm.genre.trim() || !blankForm.platform.trim())) {
      return "请先补齐项目名称、题材和发布平台。";
    }

    if (step === 2 && blankForm.prepareWithAi && blankFiles.length > 0) {
      if (!blankForm.endpointId || !blankForm.modelId.trim()) {
        return "如果要先用 AI 整理材料，请先选择模型接口并填写模型名。";
      }
    }

    return null;
  }

  function handleBlankStepChange(direction: "next" | "back") {
    setBlankError(null);
    setBlankMessage(null);

    if (direction === "back") {
      setBlankStep((current) => Math.max(current - 1, 0));
      return;
    }

    const validationError = validateBlankStep(blankStep);
    if (validationError) {
      setBlankError(validationError);
      return;
    }

    setBlankStep((current) => Math.min(current + 1, BLANK_STEP_TITLES.length - 2));
  }

  function resetBlankState() {
    setBlankResult(null);
    setBlankMessage(null);
    setBlankError(null);
    setBlankStep(0);
    setBlankFiles([]);
    setBlankFollowUpIndex(0);
    setBlankFollowUpAnswers({});
    setBlankForm((current) => ({
      ...current,
      name: "",
      genre: "",
      platform: "",
      authorNotes: "",
      tags: "",
    }));
  }

  async function uploadBlankMaterials(projectId: string) {
    const uploadedReferences: BlankPreparationResult["importedReferences"] = [];

    for (const file of blankFiles) {
      const formData = new FormData();
      formData.append("file", file);
      if (blankForm.tags.trim()) {
        formData.append("tags", blankForm.tags.trim());
      }

      const payload = await requestJson<{ id: string; filename: string }>(`/api/projects/${projectId}/references`, {
        method: "POST",
        body: formData,
      });

      uploadedReferences.push({
        id: payload.id,
        filename: payload.filename,
      });
    }

    return uploadedReferences;
  }

  async function finalizeBlankOnboarding(params: {
    projectId: string;
    draftId: string;
    output: string;
    importedReferences: BlankPreparationResult["importedReferences"];
    followUpQuestions: BlankGapQuestion[];
  }) {
    const payload = await requestJson<{
      appliedArtifactKeys: string[];
      followUpAnswerCount: number;
    }>(`/api/projects/${params.projectId}/blank-onboarding/finalize`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        digestDraftId: params.draftId,
        digestOutput: params.output,
        authorNotes: blankForm.authorNotes,
        importedReferenceIds: params.importedReferences.map((reference) => reference.id),
        followUpAnswers: params.followUpQuestions.map((question) => ({
          questionKey: question.key,
          answer: blankFollowUpAnswers[question.key] ?? "",
        })),
      }),
    });

    setBlankResult((current) =>
      current
        ? {
            ...current,
            bootstrapApplied: true,
            appliedArtifactKeys: payload.appliedArtifactKeys,
          }
        : current,
    );
    setBlankMessage(
      payload.followUpAnswerCount > 0
        ? "初始化摘要、缺口补问和项目专属规则都已写入项目文件。"
        : "初始化摘要与项目专属规则都已写入项目文件。",
    );
  }

  async function handleBlankCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const validationError = validateBlankStep(blankStep);
    if (validationError) {
      setBlankError(validationError);
      return;
    }

    setBlankPending(true);
    setBlankError(null);
    setBlankMessage("正在创建项目...");
    setBlankResult(null);
    setBlankFollowUpIndex(0);
    setBlankFollowUpAnswers({});

    const endpointLabel = selectedBlankEndpoint?.label ?? null;
    let createdProjectId: string | null = null;
    let createdProjectName = blankForm.name.trim();
    let importedReferences: BlankPreparationResult["importedReferences"] = [];

    try {
      const projectPayload = await requestJson<{ project: { id: string; name: string } }>("/api/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: blankForm.name.trim(),
          genre: blankForm.genre.trim(),
          platform: blankForm.platform.trim(),
        }),
      });

      createdProjectId = projectPayload.project.id;
      createdProjectName = projectPayload.project.name;

      if (blankFiles.length > 0) {
        setBlankMessage(`项目已创建，正在导入 ${blankFiles.length} 份作者材料...`);
        importedReferences = await uploadBlankMaterials(createdProjectId);
      }

      const baseResult: BlankPreparationResult = {
        projectId: createdProjectId,
        projectName: createdProjectName,
        importedReferences,
        usedAiPreparation: false,
        endpointLabel,
        modelId: blankForm.modelId.trim() || null,
        draftId: null,
        output: null,
        followUpQuestions: [],
        bootstrapApplied: true,
        appliedArtifactKeys: [],
      };

      if (canRunBlankAiPreparation) {
        setBlankMessage("材料已导入，正在用 AI 整理初始化摘要...");

        const generationPayload = await requestJson<{ draftId: string; output: string }>(
          `/api/projects/${createdProjectId}/generate`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              taskType: "ingest_sources",
              userInstruction: buildBlankMaterialDigestInstruction({
                projectName: blankForm.name.trim(),
                genre: blankForm.genre.trim(),
                platform: blankForm.platform.trim(),
                authorNotes: blankForm.authorNotes,
                materialFileNames: importedReferences.map((reference) => reference.filename),
              }),
              endpointId: blankForm.endpointId,
              modelId: blankForm.modelId.trim(),
              selectedArtifactIds: [],
              selectedReferenceIds: importedReferences.map((reference) => reference.id),
              selectedMcpServerIds: [],
              generationOptions: {},
            }),
          },
        );

        const followUpQuestions = buildBlankGapQuestions({
          projectName: blankForm.name.trim(),
          genre: blankForm.genre.trim(),
          platform: blankForm.platform.trim(),
          digestOutput: generationPayload.output,
        });

        setBlankResult({
          ...baseResult,
          usedAiPreparation: true,
          draftId: generationPayload.draftId,
          output: generationPayload.output,
          followUpQuestions,
          bootstrapApplied: followUpQuestions.length === 0,
        });

        if (followUpQuestions.length > 0) {
          setBlankStep(BLANK_STEP_TITLES.length - 1);
          setBlankMessage("材料已整理完成。请继续补齐系统识别出的关键缺口。");
        } else {
          setBlankMessage("材料已整理完成，正在写入项目初始化结果...");
          await finalizeBlankOnboarding({
            projectId: createdProjectId,
            draftId: generationPayload.draftId,
            output: generationPayload.output,
            importedReferences,
            followUpQuestions: [],
          });
        }
      } else {
        setBlankResult(baseResult);
        setBlankMessage(
          importedReferences.length > 0
            ? "项目和作者材料已导入，可以进入工作台继续整理。"
            : "项目已创建，可以直接进入工作台开始写作。",
        );
      }

      router.refresh();
    } catch (error) {
      if (createdProjectId) {
        setBlankResult({
          projectId: createdProjectId,
          projectName: createdProjectName,
          importedReferences,
          usedAiPreparation: false,
          endpointLabel,
          modelId: blankForm.modelId.trim() || null,
          draftId: null,
          output: null,
          followUpQuestions: [],
          bootstrapApplied: true,
          appliedArtifactKeys: [],
        });
      }

      setBlankError(
        error instanceof Error
          ? createdProjectId
            ? `${error.message}。项目已创建，可先进入工作台继续处理。`
            : error.message
          : "创建项目失败。",
      );
      setBlankMessage(null);
    } finally {
      setBlankPending(false);
    }
  }

  async function handleBlankFinalize() {
    if (!blankResult?.projectId || !blankResult.draftId || !blankResult.output) {
      return;
    }

    setBlankPending(true);
    setBlankError(null);
    setBlankMessage("正在把初始化结果写入项目文件...");

    try {
      await finalizeBlankOnboarding({
        projectId: blankResult.projectId,
        draftId: blankResult.draftId,
        output: blankResult.output,
        importedReferences: blankResult.importedReferences,
        followUpQuestions: blankResult.followUpQuestions,
      });
      router.refresh();
    } catch (error) {
      setBlankError(error instanceof Error ? error.message : "写入初始化结果失败。");
      setBlankMessage(null);
    } finally {
      setBlankPending(false);
    }
  }

  async function handleStartGuidedSession(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();

    if (!guidedSeed.genre.trim()) {
      setGuidedError("请先给出题材方向，再开始 AI 引导提问。");
      return;
    }

    setGuidedPending(true);
    setGuidedError(null);
    setGuidedMessage(null);

    try {
      const response = await fetch("/api/projects/bootstrap/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/x-ndjson, application/json",
        },
        body: JSON.stringify({
          name: guidedSeed.name.trim(),
          genre: guidedSeed.genre.trim(),
          platform: guidedSeed.platform.trim(),
          lengthHint: guidedSeed.lengthHint.trim(),
          era: guidedSeed.era.trim(),
          keywords: guidedSeed.keywords.trim(),
          endpointId: guidedSeed.endpointId || undefined,
          modelId: guidedSeed.endpointId ? guidedSeed.modelId.trim() || undefined : undefined,
        }),
      });

      const contentType = response.headers.get("content-type") ?? "";
      const nextSession = contentType.includes("application/x-ndjson")
        ? await consumeGuidedSessionStream(response, "create")
        : await readGuidedSessionResponse(response);

      applyGuidedSession(nextSession);
      setGuidedMessage(
        nextSession.mode === "ai_dynamic"
          ? `已使用 ${nextSession.runtime?.endpointLabel ?? "所选接口"} 建立 AI 动态引导会话。`
          : "已建立本地引导问卷会话。",
      );
    } catch (error) {
      setGuidedError(error instanceof Error ? error.message : "创建初始化会话失败。");
    } finally {
      setGuidedPending(false);
    }
  }

  async function handleGuidedAction(action: "answer" | "skip" | "back") {
    if (!sessionId) {
      return;
    }

    setGuidedPending(true);
    setGuidedError(null);
    setGuidedMessage(null);

    try {
      const response = await fetch(`/api/projects/bootstrap/session/${sessionId}/answer`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/x-ndjson, application/json",
        },
        body: JSON.stringify({
          action,
          answer: action === "back" ? undefined : guidedAnswer,
        }),
      });
      const contentType = response.headers.get("content-type") ?? "";
      const nextSession =
        contentType.includes("application/x-ndjson") && action !== "back"
          ? await consumeGuidedSessionStream(response, "advance")
          : await readGuidedSessionResponse(response);

      applyGuidedSession(nextSession);
      if (action === "skip") {
        setGuidedMessage("已跳过这一问。");
      }
    } catch (error) {
      setGuidedError(error instanceof Error ? error.message : "保存回答失败。");
    } finally {
      setGuidedPending(false);
    }
  }

  function applyGuidedSession(nextSession: OnboardingSessionPayload) {
    setSession(nextSession);
    setSessionId(nextSession.id);
    setGuidedAnswer(nextSession.currentQuestion?.answer ?? "");
    syncUrl("guided", nextSession.id);
  }

  async function readGuidedSessionResponse(response: Response) {
    const payload = (await response.json().catch(() => null)) as unknown;

    if (!response.ok) {
      throw new Error(readErrorMessage(payload));
    }

    const envelope = parseGuidedSessionEnvelope(payload);
    if (!envelope) {
      throw new Error("初始化会话返回格式不正确。");
    }

    return envelope.session;
  }

  async function consumeGuidedSessionStream(response: Response, stage: "create" | "advance") {
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as unknown;
      throw new Error(readErrorMessage(payload));
    }

    if (!response.body) {
      throw new Error("未收到引导问答的流式响应体。");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completedPayload: unknown = null;
    let streamError: string | null = null;

    setGuidedStreamingStage(stage);
    setGuidedStreamingOutput("");
    setGuidedMessage(stage === "create" ? "AI 正在生成首问..." : "AI 正在生成下一问...");

    async function handleLine(line: string) {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new Error("引导问答返回了无法解析的流式事件。");
      }

      const event = parseGuidedSessionStreamEvent(parsed);
      if (!event) {
        return;
      }

      switch (event.type) {
        case "started":
          setGuidedMessage(stage === "create" ? "模型已开始生成首问。" : "模型已开始生成下一问。");
          break;
        case "text-delta":
          setGuidedStreamingOutput((current) => current + event.text);
          break;
        case "completed":
          completedPayload = event.payload;
          break;
        case "error":
          streamError = readErrorMessage({
            error: {
              code: event.error.code,
              message: event.error.message ?? "AI 引导问答失败。",
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
      setGuidedStreamingStage(null);
    }

    if (streamError) {
      setGuidedStreamingOutput("");
      throw new Error(streamError);
    }

    const envelope = parseGuidedSessionEnvelope(completedPayload);
    if (!envelope) {
      setGuidedStreamingOutput("");
      throw new Error("引导问答流已结束，但没有返回完整会话结果。");
    }

    setGuidedStreamingOutput("");
    return envelope.session;
  }

  async function handleFinalizeGuidedProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sessionId) {
      return;
    }

    setGuidedPending(true);
    setGuidedError(null);
    setGuidedMessage(null);

    try {
      const payload = await requestJson<{ project: { id: string } }>(
        `/api/projects/bootstrap/session/${sessionId}/finalize`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(finalizeForm),
        },
      );

      router.push(`/projects/${payload.project.id}`);
      router.refresh();
    } catch (error) {
      setGuidedError(error instanceof Error ? error.message : "完成初始化失败。");
    } finally {
      setGuidedPending(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <SectionPanel
        title="新建项目"
        description="AI 引导模式按作者给出的题材逐步提问；空白模式按“基础资料 -> 作者材料 -> 整理方式 -> 补充关键信息”推进。"
        action={
          <div className="flex w-full flex-wrap items-center gap-2 rounded-[24px] bg-[var(--panel)] p-1 sm:w-auto">
            <Button
              type="button"
              size="sm"
              variant={mode === "blank" ? "default" : "ghost"}
              className="flex-1 sm:flex-none"
              onClick={() => {
                setMode("blank");
                syncUrl("blank");
              }}
            >
              空白创建
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === "guided" ? "default" : "ghost"}
              className="flex-1 sm:flex-none"
              onClick={() => {
                setMode("guided");
                syncUrl("guided", sessionId);
              }}
            >
              AI 引导创建
            </Button>
          </div>
        }
      >
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.9fr)]">
          <div className="space-y-5">
            {mode === "blank" ? (
              <div className="space-y-5">
                <div className="grid gap-3 sm:grid-cols-4">
                  {BLANK_STEP_TITLES.map((title, index) => {
                    const isActive = index === blankStep;
                    const isDone =
                      index < blankStep || (index === BLANK_STEP_TITLES.length - 1 && Boolean(blankResult?.bootstrapApplied));

                    return (
                      <div
                        key={title}
                        className={[
                          "rounded-[20px] border px-4 py-3",
                          isActive
                            ? "border-[var(--ring)] bg-[rgba(255,252,246,0.92)]"
                            : isDone
                              ? "border-[var(--line)] bg-[var(--paper)]"
                              : "border-dashed border-[var(--line)] bg-[rgba(255,255,255,0.4)]",
                        ].join(" ")}
                      >
                        <p className="text-xs tracking-[0.16em] text-[var(--muted-ink)] uppercase">步骤 {index + 1}</p>
                        <p className="mt-2 text-sm text-[var(--ink)]">{title}</p>
                      </div>
                    );
                  })}
                </div>

                {blankResult ? (
                  blankResult.bootstrapApplied ? (
                    <div className="space-y-4 rounded-[24px] border border-[var(--line)] bg-[rgba(255,255,255,0.48)] p-5">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-sm text-[var(--ink)]">空白项目已创建</p>
                          <p className="mt-1 text-xs leading-6 text-[var(--muted-ink)]">
                            {blankResult.projectName} · 材料 {blankResult.importedReferences.length} 份
                            {blankResult.usedAiPreparation ? " · 已生成初始化草稿" : ""}
                            {blankResult.appliedArtifactKeys.length > 0 ? " · 已写入初始化结果" : ""}
                          </p>
                        </div>
                        <Badge>{blankResult.appliedArtifactKeys.length > 0 ? "已完成初始化" : blankResult.usedAiPreparation ? "已预整理" : "已创建"}</Badge>
                      </div>

                      {blankResult.output ? (
                        <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4">
                          <p className="text-xs tracking-[0.16em] text-[var(--muted-ink)] uppercase">初始化草稿</p>
                          <div className="mt-3 max-h-80 overflow-y-auto whitespace-pre-wrap text-sm leading-7 text-[var(--ink-soft)]">
                            {blankResult.output}
                          </div>
                        </div>
                      ) : null}

                      {blankResult.appliedArtifactKeys.length > 0 ? (
                        <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4">
                          <p className="text-xs tracking-[0.16em] text-[var(--muted-ink)] uppercase">已写入文件</p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {blankResult.appliedArtifactKeys.map((artifactKey) => (
                              <Badge
                                key={artifactKey}
                                className="bg-[rgba(255,252,246,0.88)] text-[var(--muted-ink)] normal-case tracking-normal"
                              >
                                {getBlankArtifactLabel(artifactKey)}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      <div className="flex flex-wrap items-center gap-3">
                        <Button type="button" onClick={() => router.push(`/projects/${blankResult.projectId}`)}>
                          进入项目工作台
                        </Button>
                        <Button type="button" variant="secondary" onClick={resetBlankState}>
                          再创建一个
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-5 rounded-[24px] border border-[var(--line)] bg-[rgba(255,255,255,0.48)] p-5">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-sm text-[var(--ink)]">项目已创建，继续补齐关键缺口</p>
                          <p className="mt-1 text-xs leading-6 text-[var(--muted-ink)]">
                            {blankResult.projectName} · 材料 {blankResult.importedReferences.length} 份 · 问题 {blankFollowUpIndex + 1}/
                            {blankResult.followUpQuestions.length}
                          </p>
                        </div>
                        <Badge>补问阶段</Badge>
                      </div>

                      {blankResult.output ? (
                        <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4">
                          <p className="text-xs tracking-[0.16em] text-[var(--muted-ink)] uppercase">初始化草稿</p>
                          <div className="mt-3 max-h-72 overflow-y-auto whitespace-pre-wrap text-sm leading-7 text-[var(--ink-soft)]">
                            {blankResult.output}
                          </div>
                        </div>
                      ) : null}

                      {blankCurrentFollowUpQuestion ? (
                        <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4">
                          <p className="text-xs tracking-[0.16em] text-[var(--muted-ink)] uppercase">
                            缺口问题 {blankFollowUpIndex + 1}
                          </p>
                          <h3 className="mt-2 font-serif text-lg text-[var(--ink)]">{blankCurrentFollowUpQuestion.title}</h3>
                          <p className="mt-2 text-sm leading-7 text-[var(--ink-soft)]">{blankCurrentFollowUpQuestion.prompt}</p>

                          <div className="mt-4 grid gap-3 md:grid-cols-2">
                            {blankCurrentFollowUpQuestion.recommendedOptions.map((option) => (
                              <button
                                key={`${blankCurrentFollowUpQuestion.key}_${option.label}`}
                                type="button"
                                className="rounded-[18px] border border-[var(--line)] bg-[var(--paper)] p-4 text-left transition hover:border-[var(--ring)]"
                                onClick={() => {
                                  setBlankFollowUpAnswers((current) => ({
                                    ...current,
                                    [blankCurrentFollowUpQuestion.key]: option.value,
                                  }));
                                  setBlankError(null);
                                }}
                              >
                                <p className="text-sm text-[var(--ink)]">{option.label}</p>
                                <p className="mt-2 text-xs leading-6 text-[var(--muted-ink)]">
                                  {summarizeOptionPreview(option.value)}
                                </p>
                              </button>
                            ))}
                          </div>

                          <Textarea
                            className="mt-4"
                            value={blankFollowUpAnswers[blankCurrentFollowUpQuestion.key] ?? ""}
                            onChange={(event) =>
                              setBlankFollowUpAnswers((current) => ({
                                ...current,
                                [blankCurrentFollowUpQuestion.key]: event.target.value,
                              }))
                            }
                            placeholder={blankCurrentFollowUpQuestion.placeholder}
                          />
                          <p className="mt-2 text-xs leading-6 text-[var(--muted-ink)]">
                            可以先点推荐项，再按你这本书的实际情况改写；如果暂时不想细化，也可以直接留空进入下一问。
                          </p>

                          <div className="mt-5 flex flex-wrap items-center gap-3">
                            <Button
                              type="button"
                              variant="secondary"
                              disabled={blankPending || blankFollowUpIndex === 0}
                              onClick={() => setBlankFollowUpIndex((current) => Math.max(current - 1, 0))}
                            >
                              上一问
                            </Button>
                            {blankFollowUpIndex < blankResult.followUpQuestions.length - 1 ? (
                              <Button
                                type="button"
                                disabled={blankPending}
                                onClick={() =>
                                  setBlankFollowUpIndex((current) =>
                                    Math.min(current + 1, blankResult.followUpQuestions.length - 1),
                                  )
                                }
                              >
                                下一问
                              </Button>
                            ) : (
                              <Button type="button" disabled={blankPending} onClick={() => void handleBlankFinalize()}>
                                {blankPending ? "写入中" : "写入初始化结果"}
                              </Button>
                            )}
                            {blankFollowUpIndex < blankResult.followUpQuestions.length - 1 ? (
                              <Button
                                type="button"
                                variant="secondary"
                                disabled={blankPending}
                                onClick={() =>
                                  setBlankFollowUpIndex((current) =>
                                    Math.min(current + 1, blankResult.followUpQuestions.length - 1),
                                  )
                                }
                              >
                                暂时跳过
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  )
                ) : (
                  <form className="space-y-5" onSubmit={handleBlankCreate}>
                    {blankStep === 0 ? (
                      <div className="grid gap-4 md:grid-cols-2">
                        <div>
                          <label className="mb-2 block text-sm text-[var(--muted-ink)]">项目名称</label>
                          <Input
                            value={blankForm.name}
                            onChange={(event) => setBlankForm((current) => ({ ...current, name: event.target.value }))}
                            placeholder="例如：港综资本局"
                            required
                          />
                        </div>
                        <div>
                          <label className="mb-2 block text-sm text-[var(--muted-ink)]">发布平台</label>
                          <Input
                            value={blankForm.platform}
                            onChange={(event) => setBlankForm((current) => ({ ...current, platform: event.target.value }))}
                            placeholder="番茄 / 起点 / 七猫..."
                            required
                          />
                        </div>
                        <div>
                          <label className="mb-2 block text-sm text-[var(--muted-ink)]">题材</label>
                          <Input
                            value={blankForm.genre}
                            onChange={(event) => setBlankForm((current) => ({ ...current, genre: event.target.value }))}
                            placeholder="都市异能 / 历史权谋 / 港综商战..."
                            required
                          />
                        </div>
                        <div className="rounded-[24px] border border-dashed border-[var(--line)] bg-[var(--paper)] p-4 text-xs leading-6 text-[var(--muted-ink)]">
                          先把基本盘填清楚，下一步再上传你已有的设定、人物卡、旧草稿或平台规则。
                        </div>
                      </div>
                    ) : null}

                    {blankStep === 1 ? (
                      <div className="space-y-4">
                        <div>
                          <label className="mb-2 block text-sm text-[var(--muted-ink)]">作者材料</label>
                          <Input
                            type="file"
                            multiple
                            accept=".txt,.md,.markdown,.html,.htm,text/plain,text/markdown,text/html"
                            className="file:mr-3 file:rounded-full file:border-0 file:bg-[var(--panel)] file:px-3 file:py-2 file:text-xs file:text-[var(--ink)]"
                            onChange={(event) => setBlankFiles(Array.from(event.target.files ?? []))}
                          />
                          <p className="mt-2 text-xs leading-6 text-[var(--muted-ink)]">
                            这些文件会在项目创建后自动导入资料区。
                          </p>
                        </div>

                        <div className="grid gap-4 md:grid-cols-2">
                          <div>
                            <label className="mb-2 block text-sm text-[var(--muted-ink)]">资料标签</label>
                            <Input
                              value={blankForm.tags}
                              onChange={(event) => setBlankForm((current) => ({ ...current, tags: event.target.value }))}
                              placeholder="例如：世界观, 角色卡, 平台规则"
                            />
                          </div>
                          <div>
                            <label className="mb-2 block text-sm text-[var(--muted-ink)]">补充说明</label>
                            <Textarea
                              value={blankForm.authorNotes}
                              onChange={(event) =>
                                setBlankForm((current) => ({ ...current, authorNotes: event.target.value }))
                              }
                              placeholder="例如：优先整理世界规则和角色关系。"
                            />
                          </div>
                        </div>

                        <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4">
                          <p className="text-xs tracking-[0.16em] text-[var(--muted-ink)] uppercase">已选材料</p>
                          <div className="mt-3 space-y-2">
                            {blankFiles.length > 0 ? (
                              blankFiles.map((file) => (
                                <div
                                  key={`${file.name}_${file.lastModified}`}
                                  className="flex items-center justify-between gap-3 rounded-[16px] border border-[var(--line)] px-3 py-2 text-sm"
                                >
                                  <span className="truncate text-[var(--ink)]">{file.name}</span>
                                  <span className="text-xs text-[var(--muted-ink)]">{formatFileSize(file.size)}</span>
                                </div>
                              ))
                            ) : (
                              <p className="text-sm leading-7 text-[var(--muted-ink)]">
                                当前未选择文件。你也可以只创建项目骨架。
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : null}

                    {blankStep === 2 ? (
                      <div className="space-y-4">
                        <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="text-sm text-[var(--ink)]">创建后先用 AI 整理作者材料</p>
                              <p className="mt-1 text-xs leading-6 text-[var(--muted-ink)]">
                                会在导入材料后自动生成一份初始化草稿，供你进入工作台继续确认。
                              </p>
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              variant={blankForm.prepareWithAi ? "default" : "secondary"}
                              onClick={() =>
                                setBlankForm((current) => ({
                                  ...current,
                                  prepareWithAi: !current.prepareWithAi,
                                }))
                              }
                            >
                              {blankForm.prepareWithAi ? "已开启" : "已关闭"}
                            </Button>
                          </div>
                        </div>

                        {blankForm.prepareWithAi ? (
                          <div className="grid gap-4 md:grid-cols-2">
                            <div>
                              <label className="mb-2 block text-sm text-[var(--muted-ink)]">模型接口</label>
                              <Select
                                value={blankForm.endpointId}
                                onChange={(event) => {
                                  const nextEndpoint =
                                    providerEndpoints.find((endpoint) => endpoint.id === event.target.value) ?? null;
                                  setBlankForm((current) => ({
                                    ...current,
                                    endpointId: event.target.value,
                                    modelId: nextEndpoint?.defaultModel ?? current.modelId,
                                  }));
                                }}
                              >
                                <option value="">请选择模型接口</option>
                                {providerEndpoints.map((endpoint) => (
                                  <option key={endpoint.id} value={endpoint.id}>
                                    {endpoint.label} · {getProviderTypeLabel(endpoint.providerType)} · {getHealthLabel(endpoint.healthStatus)}
                                  </option>
                                ))}
                              </Select>
                            </div>
                            <div>
                              <label className="mb-2 block text-sm text-[var(--muted-ink)]">模型名</label>
                              <Input
                                value={blankForm.modelId}
                                onChange={(event) => setBlankForm((current) => ({ ...current, modelId: event.target.value }))}
                                placeholder={selectedBlankEndpoint?.defaultModel ?? "例如 gpt-5"}
                              />
                            </div>
                          </div>
                        ) : null}

                        <div className="rounded-[20px] border border-dashed border-[var(--line)] bg-[rgba(255,252,246,0.88)] p-4 text-sm leading-7 text-[var(--ink-soft)]">
                          {blankFiles.length > 0 ? (
                            blankForm.prepareWithAi ? (
                              <>
                                当前会先导入 <strong>{blankFiles.length}</strong> 份作者材料，再用
                                <strong> {selectedBlankEndpoint?.label ?? "所选接口"} </strong>
                                整理初始化草稿。
                              </>
                            ) : (
                              <>当前会先导入材料，但不会自动生成初始化草稿。</>
                            )
                          ) : (
                            <>当前没有上传材料，本次会只创建项目标准骨架。</>
                          )}
                        </div>

                        {endpointError ? <p className="text-sm text-[#9f3a2f]">{endpointError}</p> : null}
                      </div>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-3">
                      {blankStep > 0 ? (
                        <Button type="button" variant="secondary" disabled={blankPending} onClick={() => handleBlankStepChange("back")}>
                          上一步
                        </Button>
                      ) : null}

                      {blankStep < BLANK_STEP_TITLES.length - 2 ? (
                        <Button type="button" disabled={blankPending} onClick={() => handleBlankStepChange("next")}>
                          下一步
                        </Button>
                      ) : (
                        <Button type="submit" disabled={blankPending}>
                          {blankPending
                            ? "处理中"
                            : canRunBlankAiPreparation
                              ? "创建项目并整理材料"
                              : blankFiles.length > 0
                                ? "创建项目并导入材料"
                                : "创建并进入工作台"}
                        </Button>
                      )}
                    </div>

                    {blankError ? <p className="text-sm text-[#9f3a2f]">{blankError}</p> : null}
                    {blankMessage ? <p className="text-sm text-[#556d59]">{blankMessage}</p> : null}
                  </form>
                )}
                {blankResult ? (
                  <>
                    {blankError ? <p className="text-sm text-[#9f3a2f]">{blankError}</p> : null}
                    {blankMessage ? <p className="text-sm text-[#556d59]">{blankMessage}</p> : null}
                  </>
                ) : null}
              </div>
            ) : (
              <div className="space-y-5">
                {!session ? (
                  <form className="space-y-5 rounded-[24px] border border-[var(--line)] bg-[rgba(255,255,255,0.48)] p-5" onSubmit={handleStartGuidedSession}>
                    <p className="text-sm leading-7 text-[var(--ink-soft)]">
                      先给出题材方向，再决定是否接入模型接口。选了接口后会由模型逐问追问；不选时会回退到本地引导问卷。
                    </p>

                    <div className="grid gap-4 md:grid-cols-2">
                      <div>
                        <label className="mb-2 block text-sm text-[var(--muted-ink)]">模型接口</label>
                        <Select
                          value={guidedSeed.endpointId}
                          onChange={(event) => {
                            const nextEndpoint =
                              providerEndpoints.find((endpoint) => endpoint.id === event.target.value) ?? null;

                            setGuidedSeed((current) => ({
                              ...current,
                              endpointId: event.target.value,
                              modelId: nextEndpoint?.defaultModel ?? "",
                            }));
                          }}
                        >
                          <option value="">先不接 AI，使用本地问卷</option>
                          {providerEndpoints.map((endpoint) => (
                            <option key={endpoint.id} value={endpoint.id}>
                              {endpoint.label} · {getProviderTypeLabel(endpoint.providerType)} · {getHealthLabel(endpoint.healthStatus)}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div>
                        <label className="mb-2 block text-sm text-[var(--muted-ink)]">模型名</label>
                        <Input
                          value={guidedSeed.modelId}
                          onChange={(event) => setGuidedSeed((current) => ({ ...current, modelId: event.target.value }))}
                          placeholder={selectedGuidedEndpoint?.defaultModel || "未选择接口时可留空"}
                          disabled={!guidedSeed.endpointId}
                        />
                      </div>
                    </div>

                    {endpointError ? <p className="text-sm text-[#9f3a2f]">{endpointError}</p> : null}

                    <div className="grid gap-4 md:grid-cols-2">
                      <div>
                        <label className="mb-2 block text-sm text-[var(--muted-ink)]">题材方向</label>
                        <Input
                          value={guidedSeed.genre}
                          onChange={(event) => setGuidedSeed((current) => ({ ...current, genre: event.target.value }))}
                          placeholder="例如：港综商战 / 历史权谋 / 都市异能"
                          required
                        />
                      </div>
                      <div>
                        <label className="mb-2 block text-sm text-[var(--muted-ink)]">发布平台</label>
                        <Input
                          value={guidedSeed.platform}
                          onChange={(event) => setGuidedSeed((current) => ({ ...current, platform: event.target.value }))}
                          placeholder="番茄 / 起点 / 七猫..."
                        />
                      </div>
                      <div>
                        <label className="mb-2 block text-sm text-[var(--muted-ink)]">暂定名</label>
                        <Input
                          value={guidedSeed.name}
                          onChange={(event) => setGuidedSeed((current) => ({ ...current, name: event.target.value }))}
                          placeholder="可先不锁死书名"
                        />
                      </div>
                      <div>
                        <label className="mb-2 block text-sm text-[var(--muted-ink)]">篇幅预期</label>
                        <Input
                          value={guidedSeed.lengthHint}
                          onChange={(event) => setGuidedSeed((current) => ({ ...current, lengthHint: event.target.value }))}
                          placeholder="例如：180 万字长篇 / 80 万字中篇"
                        />
                      </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <div>
                        <label className="mb-2 block text-sm text-[var(--muted-ink)]">时代 / 背景</label>
                        <Input
                          value={guidedSeed.era}
                          onChange={(event) => setGuidedSeed((current) => ({ ...current, era: event.target.value }))}
                          placeholder="例如：90 年代港岛 / 架空王朝中后期"
                        />
                      </div>
                      <div>
                        <label className="mb-2 block text-sm text-[var(--muted-ink)]">关键词</label>
                        <Input
                          value={guidedSeed.keywords}
                          onChange={(event) => setGuidedSeed((current) => ({ ...current, keywords: event.target.value }))}
                          placeholder="例如：资本局、势力经营、反制、上位"
                        />
                      </div>
                    </div>

                    <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4">
                      <p className="text-xs tracking-[0.16em] text-[var(--muted-ink)] uppercase">
                        {guidedUsesAi ? "AI 动态追问重点" : "本地问卷重点"}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {guidedPreviewHints.map((item) => (
                          <Badge
                            key={item}
                            className="bg-[rgba(255,252,246,0.88)] text-[var(--muted-ink)] normal-case tracking-normal"
                          >
                            {item}
                          </Badge>
                        ))}
                      </div>
                      <p className="mt-3 text-xs leading-6 text-[var(--muted-ink)]">
                        {guidedUsesAi
                          ? `将使用 ${selectedGuidedEndpoint?.label ?? "所选接口"} / ${guidedSeed.modelId.trim() || "默认模型"} 生成首问，并在每次回答后决定下一问与推荐选项。`
                          : "未选择接口时，会回退到当前内置问卷模式，按本地规则给出问题与推荐选项。"}
                      </p>
                    </div>

                    <div className="flex items-center gap-3">
                      <Button type="submit" disabled={guidedPending}>
                        {guidedPending ? "初始化中" : guidedUsesAi ? "开始 AI 动态提问" : "开始本地引导问卷"}
                      </Button>
                    </div>
                    {guidedStreamingLabel ? (
                      <div className="rounded-[24px] border border-[var(--line)] bg-[rgba(255,250,242,0.88)] p-5">
                        <p className="text-xs tracking-[0.16em] text-[var(--muted-ink)] uppercase">实时生成</p>
                        <h3 className="mt-2 font-serif text-lg text-[var(--ink)]">{guidedStreamingLabel}</h3>
                        <p className="mt-2 text-sm leading-7 text-[var(--ink-soft)]">
                          {guidedStreamingOutput.trim()
                            ? "模型正在返回中，最终会自动整理成正式问题。"
                            : "正在等待模型返回首段内容..."}
                        </p>
                        <pre className="mt-4 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-[18px] bg-[var(--paper)] p-4 text-xs leading-6 text-[var(--muted-ink)]">
                          {guidedStreamingOutput.trim() || "正在等待模型返回首段内容..."}
                        </pre>
                      </div>
                    ) : null}
                    {guidedError ? <p className="mt-4 text-sm text-[#9f3a2f]">{guidedError}</p> : null}
                  </form>
                ) : (
                  <div className="space-y-5">
                    <div className="flex items-center justify-between gap-3 rounded-[24px] border border-[var(--line)] bg-[rgba(255,255,255,0.48)] px-5 py-4">
                      <div>
                        <p className="text-sm text-[var(--ink)]">引导进度</p>
                        <p className="mt-1 text-xs leading-6 text-[var(--muted-ink)]">
                          当前状态：{getOnboardingStatusLabel(session.status)} · 进度 {guidedProgressLabel}
                        </p>
                        <p className="text-xs leading-6 text-[var(--muted-ink)]">
                          当前模式：{session.mode === "ai_dynamic" ? "AI 动态追问" : "本地问卷"}
                          {session.mode === "ai_dynamic" && session.runtime
                            ? ` · ${session.runtime.endpointLabel ?? "已选接口"} / ${session.runtime.modelId ?? "默认模型"}`
                            : ""}
                        </p>
                      </div>
                      <Badge>{getOnboardingStatusLabel(session.status)}</Badge>
                    </div>

                    {guidedStreamingLabel ? (
                      <div className="rounded-[24px] border border-[var(--line)] bg-[rgba(255,250,242,0.88)] p-5">
                        <p className="text-xs tracking-[0.16em] text-[var(--muted-ink)] uppercase">实时生成</p>
                        <h3 className="mt-2 font-serif text-lg text-[var(--ink)]">{guidedStreamingLabel}</h3>
                        <p className="mt-2 text-sm leading-7 text-[var(--ink-soft)]">
                          {guidedStreamingOutput.trim()
                            ? "模型正在返回中，最终会自动整理成正式问题。"
                            : "正在等待模型返回首段内容..."}
                        </p>
                        <pre className="mt-4 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-[18px] bg-[var(--paper)] p-4 text-xs leading-6 text-[var(--muted-ink)]">
                          {guidedStreamingOutput.trim() || "正在等待模型返回首段内容..."}
                        </pre>
                      </div>
                    ) : null}

                    {session.currentQuestion ? (
                      <div className="rounded-[24px] border border-[var(--line)] bg-[rgba(255,255,255,0.48)] p-5">
                        <p className="text-xs tracking-[0.16em] text-[var(--muted-ink)] uppercase">
                          问题 {session.currentQuestionIndex + 1}
                        </p>
                        <p className="mt-2 text-xs tracking-[0.16em] text-[var(--muted-ink)] uppercase">
                          {session.currentQuestion.source === "ai" ? "AI 动态提问" : "本地规则提问"}
                        </p>
                        <h3 className="mt-2 font-serif text-lg text-[var(--ink)]">{session.currentQuestion.title}</h3>
                        <p className="mt-2 text-sm leading-7 text-[var(--ink-soft)]">{session.currentQuestion.prompt}</p>
                        {session.currentQuestion.recommendedOptions.length > 0 ? (
                          <div className="mt-4 space-y-3">
                            <p className="text-xs tracking-[0.16em] text-[var(--muted-ink)] uppercase">推荐选项</p>
                            <div className="grid gap-3 md:grid-cols-2">
                              {session.currentQuestion.recommendedOptions.map((option) => (
                                <button
                                  key={`${session.currentQuestion?.key}_${option.label}`}
                                  type="button"
                                  className="rounded-[18px] border border-[var(--line)] bg-[var(--paper)] p-4 text-left transition hover:border-[var(--ring)]"
                                  onClick={() => {
                                    setGuidedAnswer(option.value);
                                    setGuidedError(null);
                                  }}
                                >
                                  <p className="text-sm text-[var(--ink)]">{option.label}</p>
                                  <p className="mt-2 text-xs leading-6 text-[var(--muted-ink)]">
                                    {summarizeOptionPreview(option.value)}
                                  </p>
                                </button>
                              ))}
                            </div>
                            <p className="text-xs leading-6 text-[var(--muted-ink)]">
                              可以先点一条推荐，再按你的小说实际情况改写。
                            </p>
                          </div>
                        ) : null}
                        {session.currentQuestion.key === "project_basics" && guidedAnswer.trim() ? (
                          <p className="mt-4 text-xs leading-6 text-[var(--muted-ink)]">
                            这里已经预填了你前面给出的题材方向，可以直接修改后继续。
                          </p>
                        ) : null}
                        <Textarea
                          className="mt-4"
                          value={guidedAnswer}
                          onChange={(event) => setGuidedAnswer(event.target.value)}
                          placeholder={session.currentQuestion.placeholder}
                        />

                        <div className="mt-5 flex flex-wrap items-center gap-3">
                          <Button
                            type="button"
                            variant="secondary"
                            disabled={guidedPending || session.currentQuestionIndex === 0}
                            onClick={() => void handleGuidedAction("back")}
                          >
                            上一步
                          </Button>
                          {session.currentQuestion.optional ? (
                            <Button
                              type="button"
                              variant="secondary"
                              disabled={guidedPending}
                              onClick={() => void handleGuidedAction("skip")}
                            >
                              跳过这一问
                            </Button>
                          ) : null}
                          <Button type="button" disabled={guidedPending} onClick={() => void handleGuidedAction("answer")}>
                            {guidedPending ? "保存中" : "记录并继续"}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <form className="space-y-4 rounded-[24px] border border-[var(--line)] bg-[rgba(255,255,255,0.48)] p-5" onSubmit={handleFinalizeGuidedProject}>
                        <div className="grid gap-4 md:grid-cols-3">
                          <div>
                            <label className="mb-2 block text-sm text-[var(--muted-ink)]">项目名称</label>
                            <Input
                              value={finalizeForm.name}
                              onChange={(event) => setFinalizeForm((current) => ({ ...current, name: event.target.value }))}
                              placeholder="请输入项目名"
                              required
                            />
                          </div>
                          <div>
                            <label className="mb-2 block text-sm text-[var(--muted-ink)]">题材</label>
                            <Input
                              value={finalizeForm.genre}
                              onChange={(event) => setFinalizeForm((current) => ({ ...current, genre: event.target.value }))}
                              placeholder="请输入题材"
                              required
                            />
                          </div>
                          <div>
                            <label className="mb-2 block text-sm text-[var(--muted-ink)]">发布平台</label>
                            <Input
                              value={finalizeForm.platform}
                              onChange={(event) => setFinalizeForm((current) => ({ ...current, platform: event.target.value }))}
                              placeholder="请输入平台"
                              required
                            />
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-3">
                          {session.status === "finalized" && session.finalizedProjectId ? (
                            <Button type="button" onClick={() => router.push(`/projects/${session.finalizedProjectId}`)}>
                              进入已创建项目
                            </Button>
                          ) : (
                            <>
                              <Button type="submit" disabled={guidedPending}>
                                {guidedPending ? "创建中" : "创建项目并写入初始化结果"}
                              </Button>
                              <Button type="button" variant="secondary" disabled={guidedPending} onClick={() => void handleGuidedAction("back")}>
                                返回上一步
                              </Button>
                            </>
                          )}
                        </div>
                      </form>
                    )}

                    {guidedError ? <p className="text-sm text-[#9f3a2f]">{guidedError}</p> : null}
                    {guidedMessage ? <p className="text-sm text-[#556d59]">{guidedMessage}</p> : null}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="space-y-5">
            <SectionPanel title="初始化摘要" description={mode === "blank" ? "空白模式会汇总你已填写的基本信息和作者材料；若开启 AI 预整理，还会给出缺口补问并在确认后写入标准文件。" : "引导式创建会先生成结构化摘要，再写入标准项目文件。"}>
              {mode === "blank" ? (
                <div className="space-y-4">
                  <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4 text-xs leading-6 text-[var(--muted-ink)]">
                    <p>项目名：{blankResult?.projectName ?? (blankForm.name.trim() || "待填写")}</p>
                    <p>题材：{blankForm.genre.trim() || "待填写"}</p>
                    <p>平台：{blankForm.platform.trim() || "待填写"}</p>
                    <p>材料数量：{blankResult?.importedReferences.length ?? blankFiles.length}</p>
                    <p>AI 预整理：{blankResult?.usedAiPreparation ? "已生成" : blankForm.prepareWithAi ? "开启" : "关闭"}</p>
                    <p>缺口补问：{blankResult ? `${blankResult.followUpQuestions.length} 题` : "待识别"}</p>
                    <p>初始化写入：{blankResult?.bootstrapApplied ? "已完成" : blankResult ? "待确认" : "未开始"}</p>
                  </div>

                  {blankResult?.output ? (
                    <div className="rounded-[18px] border border-[var(--line)] bg-[var(--paper)] p-4">
                      <p className="text-sm text-[var(--ink)]">AI 初始化草稿</p>
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-[var(--ink-soft)]">
                        {blankResult.output}
                      </p>
                    </div>
                  ) : blankResult?.followUpQuestions.length ? (
                    <div className="rounded-[18px] border border-[var(--line)] bg-[var(--paper)] p-4">
                      <p className="text-sm text-[var(--ink)]">待补充缺口</p>
                      <div className="mt-3 space-y-2">
                        {blankResult.followUpQuestions.map((question, index) => (
                          <div key={question.key} className="flex items-center justify-between gap-3 rounded-[16px] border border-[var(--line)] px-3 py-2 text-sm">
                            <span className="text-[var(--ink)]">
                              {index + 1}. {question.title}
                            </span>
                            <Badge className="bg-[rgba(255,252,246,0.88)] text-[var(--muted-ink)] normal-case tracking-normal">
                              {question.source === "digest" ? "来自整理摘要" : "系统补问"}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : blankFiles.length > 0 ? (
                    blankFiles.map((file) => (
                      <div key={`${file.name}_${file.lastModified}`} className="rounded-[18px] border border-[var(--line)] bg-[var(--paper)] p-4">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm text-[var(--ink)]">{file.name}</p>
                          <Badge>{formatFileSize(file.size)}</Badge>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm leading-7 text-[var(--muted-ink)]">
                      当前还没有选择作者材料。你可以只建项目骨架，也可以先上传设定、人物卡和旧草稿让系统帮你整理。
                    </p>
                  )}
                </div>
              ) : session ? (
                <div className="space-y-4">
                  <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4 text-xs leading-6 text-[var(--muted-ink)]">
                    <p>引导模式：{session.mode === "ai_dynamic" ? "AI 动态追问" : "本地问卷"}</p>
                    {session.mode === "ai_dynamic" && session.runtime ? (
                      <p>
                        使用接口：{session.runtime.endpointLabel ?? "已选接口"} / {session.runtime.modelId ?? "默认模型"}
                      </p>
                    ) : null}
                    <p>项目名建议：{session.summary.metadata.nameHint ?? "待确认"}</p>
                    <p>题材建议：{session.summary.metadata.genreHint ?? "待确认"}</p>
                    <p>平台建议：{session.summary.metadata.platformHint ?? "待确认"}</p>
                    <p>篇幅提示：{session.summary.metadata.lengthHint ?? "未提及"}</p>
                    <p>是否偏考据：{session.summary.metadata.requiresResearch ? "是" : "否"}</p>
                  </div>

                  {session.summary.answers.map((entry) => (
                    <div key={entry.questionKey} className="rounded-[18px] border border-[var(--line)] bg-[var(--paper)] p-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm text-[var(--ink)]">{entry.title}</p>
                        <Badge className={entry.answer ? "" : "bg-[rgba(191,145,81,0.12)] text-[#8f6937]"}>
                          {entry.answer ? "已记录" : entry.skipped ? "已跳过" : "待回答"}
                        </Badge>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-[var(--ink-soft)]">
                        {entry.answer || "这一项暂时为空。"}
                      </p>
                    </div>
                  ))}
                </div>
              ) : Object.values(guidedSeed).some((value) => value.trim()) ? (
                <div className="space-y-4">
                  <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4 text-xs leading-6 text-[var(--muted-ink)]">
                    <p>提问模式：{guidedUsesAi ? "AI 动态追问" : "本地问卷"}</p>
                    {guidedUsesAi ? (
                      <p>
                        预选接口：{selectedGuidedEndpoint?.label ?? "已选接口"} / {guidedSeed.modelId.trim() || "默认模型"}
                      </p>
                    ) : null}
                    <p>题材方向：{guidedSeed.genre.trim() || "待填写"}</p>
                    <p>发布平台：{guidedSeed.platform.trim() || "待填写"}</p>
                    <p>篇幅预期：{guidedSeed.lengthHint.trim() || "待填写"}</p>
                    <p>时代 / 背景：{guidedSeed.era.trim() || "待填写"}</p>
                    <p>关键词：{guidedSeed.keywords.trim() || "待填写"}</p>
                  </div>
                  <div className="rounded-[18px] border border-[var(--line)] bg-[var(--paper)] p-4">
                    <p className="text-sm text-[var(--ink)]">预判提问重点</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {guidedPreviewHints.map((item) => (
                        <Badge
                          key={item}
                          className="bg-[rgba(255,252,246,0.88)] text-[var(--muted-ink)] normal-case tracking-normal"
                        >
                          {item}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-sm leading-7 text-[var(--muted-ink)]">
                  引导模式会以作者给出的题材为起点。选了模型接口时由 AI 动态决定下一问；未选择接口时回退到本地问卷。
                </p>
              )}
            </SectionPanel>

            <SectionPanel title="将会生成的文件" description="双模式都会初始化标准项目文件；完成 AI/空白初始化确认后，都会补齐项目专属规则文件。">
              <div className="space-y-4">
                <div className="grid gap-3">
                  {STANDARD_ARTIFACTS.map((filename) => (
                    <div key={filename} className="rounded-[18px] border border-[var(--line)] bg-[var(--paper)] px-4 py-3 text-sm">
                      {filename}
                    </div>
                  ))}
                </div>

                <div className="grid gap-3">
                  {GUIDED_OVERLAYS.map((filename) => (
                    <div key={filename} className="rounded-[18px] border border-dashed border-[var(--line)] bg-[rgba(255,252,246,0.88)] px-4 py-3 text-sm">
                      {filename}
                    </div>
                  ))}
                  <div className="rounded-[18px] border border-dashed border-[var(--line)] bg-[rgba(255,252,246,0.88)] px-4 py-3 text-sm">
                    空白模式会先生成材料整理 Draft，确认补问后再回写标准文件与项目专属 overlay
                  </div>
                </div>
              </div>
            </SectionPanel>
          </div>
        </div>
      </SectionPanel>
    </div>
  );
}
