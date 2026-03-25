import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { ApiError, jsonError, jsonOk, parseJson } from "@/lib/api/http";
import { onboardingSessionAnswerSchema } from "@/lib/api/schemas";
import { resolveRequestUser } from "@/lib/auth/identity";
import { normalizeGenerationError, shouldUseStreamingGeneration } from "@/lib/generation/execute";
import {
  buildOnboardingSummary,
  getRemainingOnboardingQuestions,
  normalizeOnboardingSummary,
  ONBOARDING_QUESTIONS,
  serializeOnboardingSession,
  upsertOnboardingAnswer,
} from "@/lib/projects/onboarding";
import { planAiOnboardingQuestion, planAiOnboardingQuestionStream } from "@/lib/projects/onboarding-ai";
import { toPrismaJson } from "@/lib/prisma-json";

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

async function updateSerializedOnboardingSession(input: {
  sessionId: string;
  status: "active" | "ready";
  currentQuestionIndex: number;
  answers: Prisma.InputJsonValue;
  summary: Prisma.InputJsonValue;
}) {
  const updatedSession = await prisma.projectOnboardingSession.update({
    where: { id: input.sessionId },
    data: {
      status: input.status,
      currentQuestionIndex: input.currentQuestionIndex,
      answers: input.answers,
      summary: input.summary,
    },
  });

  return serializeOnboardingSession({
    ...updatedSession,
    status: updatedSession.status,
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const [{ id }, user] = await Promise.all([params, resolveRequestUser(request)]);
    const payload = await parseJson(request, onboardingSessionAnswerSchema);
    const session = await prisma.projectOnboardingSession.findFirst({
      where: {
        id,
        userId: user.id,
      },
    });

    if (!session) {
      return Response.json({ error: { code: "NOT_FOUND", message: "Onboarding session not found." } }, { status: 404 });
    }

    if (session.status === "finalized") {
      throw new ApiError(409, "CONFLICT", "This onboarding session has already been finalized.");
    }

    const serializedSession = serializeOnboardingSession({
      ...session,
      status: session.status,
    });
    const answers = serializedSession.answers;
    const summary = normalizeOnboardingSummary(session.summary, answers);
    let nextAnswers = answers;
    let nextQuestionIndex = session.currentQuestionIndex;
    let nextStatus: "active" | "ready" = session.status === "ready" ? "ready" : "active";
    let nextSummary = summary;

    if (payload.action === "back") {
      if (summary.mode === "ai_dynamic") {
        const nextHistory = [...summary.dynamic.history];

        if (session.status === "ready") {
          nextStatus = "active";
          nextQuestionIndex = Math.max(nextHistory.length - 1, 0);
        } else if (nextHistory.length > 1) {
          nextHistory.pop();
          nextQuestionIndex = Math.max(nextHistory.length - 1, 0);
        } else {
          nextQuestionIndex = 0;
        }

        nextSummary = buildOnboardingSummary(nextAnswers, {
          mode: summary.mode,
          runtime: summary.runtime,
          dynamicHistory: nextHistory,
        });
      } else {
        nextQuestionIndex = Math.max(session.currentQuestionIndex - 1, 0);
        nextStatus = "active";
        nextSummary = buildOnboardingSummary(nextAnswers, {
          mode: summary.mode,
          runtime: summary.runtime,
          dynamicHistory: summary.dynamic.history,
        });
      }
    } else {
      const currentQuestion = serializedSession.currentQuestion;

      if (!currentQuestion) {
        throw new ApiError(422, "VALIDATION_ERROR", "The onboarding session is ready to finalize.");
      }

      if (payload.action === "skip" && !currentQuestion.optional) {
        throw new ApiError(422, "VALIDATION_ERROR", "This question cannot be skipped.");
      }

      const answer = (payload.answer ?? "").trim();
      if (payload.action === "answer" && !answer) {
        throw new ApiError(422, "VALIDATION_ERROR", "Answer content is required.");
      }

      nextAnswers = upsertOnboardingAnswer(answers, currentQuestion.key, answer, payload.action === "skip");
      const remainingQuestions = getRemainingOnboardingQuestions(nextAnswers);

      if (summary.mode === "ai_dynamic") {
        const nextHistory = [...summary.dynamic.history];

        if (remainingQuestions.length === 0) {
          nextQuestionIndex = ONBOARDING_QUESTIONS.length;
          nextStatus = "ready";
          nextSummary = buildOnboardingSummary(nextAnswers, {
            mode: summary.mode,
            runtime: summary.runtime,
            dynamicHistory: nextHistory,
          });
        } else {
          if (!summary.runtime?.endpointId || !summary.runtime.modelId) {
            throw new ApiError(422, "VALIDATION_ERROR", "The AI onboarding runtime is incomplete.");
          }

          const endpoint = await prisma.providerEndpoint.findFirst({
            where: {
              id: summary.runtime.endpointId,
              userId: user.id,
              archivedAt: null,
            },
          });

          if (!endpoint) {
            return Response.json({ error: { code: "NOT_FOUND", message: "Endpoint not found." } }, { status: 404 });
          }

          const partialSummary = buildOnboardingSummary(nextAnswers, {
            mode: summary.mode,
            runtime: summary.runtime,
            dynamicHistory: nextHistory,
          });

          if (shouldUseStreamingGeneration(endpoint) && requestWantsNdjson(request)) {
            const execution = await planAiOnboardingQuestionStream({
              endpoint,
              modelId: summary.runtime.modelId,
              answers: nextAnswers,
              summary: partialSummary,
            });
            const stream = createNdjsonStreamWriter();

            void (async () => {
              try {
                await stream.write({ type: "started" });

                for await (const chunk of execution.textStream) {
                  if (!chunk) {
                    continue;
                  }

                  await stream.write({
                    type: "text-delta",
                    text: chunk,
                  });
                }

                const nextQuestion = await execution.completed;
                const nextDynamicHistory = [...nextHistory, nextQuestion];
                const streamedSummary = buildOnboardingSummary(nextAnswers, {
                  mode: summary.mode,
                  runtime: summary.runtime,
                  dynamicHistory: nextDynamicHistory,
                });
                const updatedSession = await updateSerializedOnboardingSession({
                  sessionId: session.id,
                  status: "active",
                  currentQuestionIndex: Math.max(nextDynamicHistory.length - 1, 0),
                  answers: toPrismaJson(nextAnswers),
                  summary: toPrismaJson(streamedSummary),
                });

                await stream.write({
                  type: "completed",
                  payload: { session: updatedSession },
                });
              } catch (error) {
                const normalized = normalizeGenerationError(error);
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

          const nextQuestion = await planAiOnboardingQuestion({
            endpoint,
            modelId: summary.runtime.modelId,
            answers: nextAnswers,
            summary: partialSummary,
          });
          const nextDynamicHistory = [...nextHistory, nextQuestion];

          nextQuestionIndex = Math.max(nextDynamicHistory.length - 1, 0);
          nextStatus = "active";
          nextSummary = buildOnboardingSummary(nextAnswers, {
            mode: summary.mode,
            runtime: summary.runtime,
            dynamicHistory: nextDynamicHistory,
          });
        }
      } else {
        nextQuestionIndex = Math.min(session.currentQuestionIndex + 1, ONBOARDING_QUESTIONS.length);
        nextStatus = nextQuestionIndex >= ONBOARDING_QUESTIONS.length ? "ready" : "active";
        nextSummary = buildOnboardingSummary(nextAnswers, {
          mode: summary.mode,
          runtime: summary.runtime,
          dynamicHistory: summary.dynamic.history,
        });
      }
    }

    const updatedSession = await updateSerializedOnboardingSession({
      sessionId: session.id,
      status: nextStatus,
      currentQuestionIndex: nextQuestionIndex,
      answers: toPrismaJson(nextAnswers),
      summary: toPrismaJson(nextSummary),
    });

    return jsonOk({ session: updatedSession });
  } catch (error) {
    return jsonError(error);
  }
}
