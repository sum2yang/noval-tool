import "server-only";

import type { ProviderEndpoint } from "@prisma/client";
import { generateText, streamText } from "ai";

import { ApiError } from "@/lib/api/http";
import { normalizeGenerationError } from "@/lib/generation/execute";
import {
  ONBOARDING_QUESTIONS,
  type DynamicOnboardingQuestion,
  type OnboardingAnswerEntry,
  type OnboardingQuestionKey,
  type OnboardingRecommendedOption,
  type OnboardingSummary,
} from "@/lib/projects/onboarding";
import { createLanguageModel } from "@/lib/providers/factory";

type PlanAiOnboardingQuestionInput = {
  endpoint: ProviderEndpoint;
  modelId: string;
  answers: OnboardingAnswerEntry[];
  summary: OnboardingSummary;
};

export type PlanAiOnboardingQuestionStreamResult = {
  textStream: AsyncIterable<string>;
  completed: Promise<DynamicOnboardingQuestion>;
};

type RawAiOnboardingQuestionResult = {
  questionKey: OnboardingQuestionKey;
  title: string;
  prompt: string;
  placeholder: string;
  recommendedOptions: OnboardingRecommendedOption[];
};

const QUESTION_BY_KEY = new Map(ONBOARDING_QUESTIONS.map((question) => [question.key, question]));
const AI_ONBOARDING_PROMPT_MARKER = "ONBOARDING_DYNAMIC_JSON";
const AI_ONBOARDING_TIMEOUT_MS = 120000;

type DeferredPromise<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function createDeferredPromise<T>(): DeferredPromise<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeText(value: unknown) {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
}

function sanitizeRecommendedOptions(value: unknown) {
  if (!Array.isArray(value)) {
    return [] satisfies OnboardingRecommendedOption[];
  }

  const seen = new Set<string>();

  return value.flatMap((row) => {
    if (!isRecord(row)) {
      return [];
    }

    const label = sanitizeText(row.label);
    const optionValue = sanitizeText(row.value);
    if (!label || !optionValue || seen.has(optionValue)) {
      return [];
    }

    seen.add(optionValue);
    return [
      {
        label,
        value: optionValue,
      },
    ];
  });
}

function extractJsonObject(text: string) {
  const trimmed = text.trim();
  const unwrapped = trimmed.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const startIndex = unwrapped.indexOf("{");
  const endIndex = unwrapped.lastIndexOf("}");

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    throw new ApiError(502, "OUTPUT_CONTRACT_ERROR", "The onboarding model did not return a JSON object.");
  }

  const candidate = unwrapped.slice(startIndex, endIndex + 1);

  try {
    return JSON.parse(candidate) as unknown;
  } catch (error) {
    throw new ApiError(
      502,
      "OUTPUT_CONTRACT_ERROR",
      error instanceof Error
        ? `The onboarding model returned invalid JSON: ${error.message}`
        : "The onboarding model returned invalid JSON.",
    );
  }
}

function coerceAiOnboardingQuestionResult(
  value: unknown,
  remainingKeys: Set<OnboardingQuestionKey>,
): RawAiOnboardingQuestionResult {
  if (!isRecord(value)) {
    throw new ApiError(502, "OUTPUT_CONTRACT_ERROR", "The onboarding model response was not an object.");
  }

  const requestedKey = sanitizeText(value.questionKey) as OnboardingQuestionKey;
  const questionKey = remainingKeys.has(requestedKey)
    ? requestedKey
    : Array.from(remainingKeys)[0];
  const canonicalQuestion = QUESTION_BY_KEY.get(questionKey);

  if (!canonicalQuestion) {
    throw new ApiError(502, "OUTPUT_CONTRACT_ERROR", `Unknown onboarding question key: ${questionKey}`);
  }

  const title = sanitizeText(value.title) || canonicalQuestion.title;
  const prompt = sanitizeText(value.prompt) || canonicalQuestion.prompt;
  const placeholder = sanitizeText(value.placeholder) || canonicalQuestion.placeholder;
  const recommendedOptions = sanitizeRecommendedOptions(value.recommendedOptions).slice(0, 3);

  return {
    questionKey,
    title,
    prompt,
    placeholder,
    recommendedOptions,
  };
}

function renderAnsweredSlots(summary: OnboardingSummary) {
  const answered = summary.answers.filter((entry) => entry.answer || entry.skipped);

  if (answered.length === 0) {
    return "无";
  }

  return answered
    .map((entry) =>
      [
        `- ${entry.questionKey} / ${entry.title}`,
        entry.skipped ? "  已跳过" : `  ${entry.answer}`,
      ].join("\n"),
    )
    .join("\n");
}

function renderRemainingSlots(remainingKeys: OnboardingQuestionKey[]) {
  return remainingKeys
    .map((key) => {
      const question = QUESTION_BY_KEY.get(key);
      return question
        ? `- ${question.key} | ${question.title} | optional=${question.optional ? "true" : "false"} | default_prompt=${question.prompt}`
        : null;
    })
    .filter(Boolean)
    .join("\n");
}

function buildAiOnboardingPrompt(summary: OnboardingSummary, remainingKeys: OnboardingQuestionKey[]) {
  return [
    "你是中文小说项目初始化向导，负责决定下一条最值得追问的问题。",
    "目标是帮助作者把小说基本盘补齐，而不是自由聊天。",
    "必须遵守以下规则：",
    "1. 只能从 remaining slots 里选择一个 questionKey。",
    "2. 不要重复追问已经有明确答案的槽位。",
    "3. prompt 必须是中文，对作者直接发问，具体且贴合题材。",
    "4. placeholder 提供可直接改写的回答草稿。",
    "5. recommendedOptions 提供 2 到 3 条中文推荐选项，每条都要可直接点选后改写。",
    "6. 只输出 JSON 对象，不要输出 markdown、解释或代码块。",
    "",
    AI_ONBOARDING_PROMPT_MARKER,
    `项目名提示：${summary.metadata.nameHint ?? "未定"}`,
    `题材提示：${summary.metadata.genreHint ?? "未定"}`,
    `平台提示：${summary.metadata.platformHint ?? "未定"}`,
    `篇幅提示：${summary.metadata.lengthHint ?? "未定"}`,
    `是否偏考据：${summary.metadata.requiresResearch ? "是" : "否"}`,
    "",
    "当前摘要：",
    `- project_basics: ${summary.sections.projectBasics || "未填写"}`,
    `- core_conflict: ${summary.sections.coreConflict || "未填写"}`,
    `- world_rules: ${summary.sections.worldRules || "未填写"}`,
    `- factions: ${summary.sections.factions || "未填写"}`,
    `- style_rules: ${summary.sections.styleRules || "未填写"}`,
    `- research_needs: ${summary.sections.researchNeeds || "未填写"}`,
    "",
    "answered slots:",
    renderAnsweredSlots(summary),
    "",
    "remaining slots:",
    renderRemainingSlots(remainingKeys),
    "",
    '输出 JSON schema: {"questionKey":"core_conflict","title":"...","prompt":"...","placeholder":"...","recommendedOptions":[{"label":"...","value":"..."}]}',
  ].join("\n");
}

function getRemainingQuestionKeys(answers: OnboardingAnswerEntry[]) {
  return ONBOARDING_QUESTIONS
    .map((question) => question.key)
    .filter((key) => !answers.some((entry) => entry.questionKey === key && (entry.answer || entry.skipped)));
}

function buildDynamicOnboardingQuestion(text: string, remainingKeys: OnboardingQuestionKey[]) {
  const parsed = extractJsonObject(text);
  const nextQuestion = coerceAiOnboardingQuestionResult(parsed, new Set(remainingKeys));
  const canonicalQuestion = QUESTION_BY_KEY.get(nextQuestion.questionKey);

  if (!canonicalQuestion) {
    throw new ApiError(502, "OUTPUT_CONTRACT_ERROR", `Unknown onboarding question key: ${nextQuestion.questionKey}`);
  }

  return {
    key: canonicalQuestion.key,
    title: nextQuestion.title,
    prompt: nextQuestion.prompt,
    placeholder: nextQuestion.placeholder,
    optional: canonicalQuestion.optional,
    recommendedOptions: nextQuestion.recommendedOptions,
    askedAt: new Date().toISOString(),
    source: "ai" as const,
  };
}

export async function planAiOnboardingQuestion(
  input: PlanAiOnboardingQuestionInput,
): Promise<DynamicOnboardingQuestion> {
  const remainingKeys = getRemainingQuestionKeys(input.answers);

  if (remainingKeys.length === 0) {
    throw new ApiError(422, "VALIDATION_ERROR", "No onboarding question remains for AI planning.");
  }

  try {
    const result = await generateText({
      model: createLanguageModel(input.endpoint, input.modelId),
      prompt: buildAiOnboardingPrompt(input.summary, remainingKeys),
      temperature: 0.3,
      maxOutputTokens: 1200,
      maxRetries: 0,
      timeout: {
        totalMs: AI_ONBOARDING_TIMEOUT_MS,
      },
    });
    return buildDynamicOnboardingQuestion(result.text, remainingKeys);
  } catch (error) {
    throw normalizeGenerationError(error);
  }
}

export async function planAiOnboardingQuestionStream(
  input: PlanAiOnboardingQuestionInput,
): Promise<PlanAiOnboardingQuestionStreamResult> {
  const remainingKeys = getRemainingQuestionKeys(input.answers);

  if (remainingKeys.length === 0) {
    throw new ApiError(422, "VALIDATION_ERROR", "No onboarding question remains for AI planning.");
  }

  const completed = createDeferredPromise<DynamicOnboardingQuestion>();
  void completed.promise.catch(() => undefined);
  let settled = false;
  let streamedText = "";

  async function resolveCompleted(value: DynamicOnboardingQuestion) {
    if (settled) {
      return;
    }

    settled = true;
    completed.resolve(value);
  }

  async function rejectCompleted(error: unknown) {
    if (settled) {
      return;
    }

    settled = true;
    completed.reject(normalizeGenerationError(error));
  }

  const result = streamText({
    model: createLanguageModel(input.endpoint, input.modelId),
    prompt: buildAiOnboardingPrompt(input.summary, remainingKeys),
    temperature: 0.3,
    maxOutputTokens: 1200,
    maxRetries: 0,
    timeout: {
      totalMs: AI_ONBOARDING_TIMEOUT_MS,
    },
    onAbort: async () => {
      await rejectCompleted(new ApiError(499, "CANCELED", "The onboarding stream was aborted."));
    },
    onError: async ({ error }) => {
      await rejectCompleted(error);
    },
  });

  return {
    textStream: {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const chunk of result.textStream) {
            streamedText += chunk;
            yield chunk;
          }

          await resolveCompleted(buildDynamicOnboardingQuestion(streamedText, remainingKeys));
        } catch (error) {
          await rejectCompleted(error);
          throw error;
        }
      },
    },
    completed: completed.promise,
  };
}
