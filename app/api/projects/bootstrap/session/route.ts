import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { ApiError, jsonCreated, jsonError, parseJson } from "@/lib/api/http";
import { onboardingSessionCreateSchema } from "@/lib/api/schemas";
import { resolveRequestUser } from "@/lib/auth/identity";
import { normalizeGenerationError, shouldUseStreamingGeneration } from "@/lib/generation/execute";
import {
  buildOnboardingSeedAnswers,
  buildOnboardingSummary,
  getRemainingOnboardingQuestions,
  ONBOARDING_QUESTIONS,
  serializeOnboardingSession,
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

async function createSerializedOnboardingSession(input: {
  userId: string;
  status: "active" | "ready";
  currentQuestionIndex: number;
  answers: Prisma.InputJsonValue;
  summary: Prisma.InputJsonValue;
}) {
  const session = await prisma.projectOnboardingSession.create({
    data: {
      userId: input.userId,
      status: input.status,
      currentQuestionIndex: input.currentQuestionIndex,
      answers: input.answers,
      summary: input.summary,
    },
  });

  return serializeOnboardingSession({
    ...session,
    status: session.status,
  });
}

export async function POST(request: Request) {
  try {
    const user = await resolveRequestUser(request);
    const payload = await parseJson(request, onboardingSessionCreateSchema);
    const initialAnswers = buildOnboardingSeedAnswers(payload);
    let status: "active" | "ready" = "active";
    let currentQuestionIndex = 0;
    let summary = buildOnboardingSummary(initialAnswers);

    if (payload.endpointId) {
      const endpoint = await prisma.providerEndpoint.findFirst({
        where: {
          id: payload.endpointId,
          userId: user.id,
        },
      });

      if (!endpoint) {
        return Response.json({ error: { code: "NOT_FOUND", message: "Endpoint not found." } }, { status: 404 });
      }

      const resolvedModelId = payload.modelId?.trim() || endpoint.defaultModel.trim();
      if (!resolvedModelId) {
        throw new ApiError(422, "VALIDATION_ERROR", "Please fill in a model name for AI-guided onboarding.");
      }

      const runtime = {
        endpointId: endpoint.id,
        endpointLabel: endpoint.label,
        modelId: resolvedModelId,
        providerType: endpoint.providerType,
      };
      const pendingQuestions = getRemainingOnboardingQuestions(initialAnswers);

      if (pendingQuestions.length === 0) {
        status = "ready";
        currentQuestionIndex = ONBOARDING_QUESTIONS.length;
        summary = buildOnboardingSummary(initialAnswers, {
          mode: "ai_dynamic",
          runtime,
          dynamicHistory: [],
        });
      } else {
        const seededSummary = buildOnboardingSummary(initialAnswers, {
          mode: "ai_dynamic",
          runtime,
          dynamicHistory: [],
        });

        if (shouldUseStreamingGeneration(endpoint) && requestWantsNdjson(request)) {
          const execution = await planAiOnboardingQuestionStream({
            endpoint,
            modelId: resolvedModelId,
            answers: initialAnswers,
            summary: seededSummary,
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

              const firstQuestion = await execution.completed;
              const nextSummary = buildOnboardingSummary(initialAnswers, {
                mode: "ai_dynamic",
                runtime,
                dynamicHistory: [firstQuestion],
              });
              const session = await createSerializedOnboardingSession({
                userId: user.id,
                status: "active",
                currentQuestionIndex: 0,
                answers: toPrismaJson(initialAnswers),
                summary: toPrismaJson(nextSummary),
              });

              await stream.write({
                type: "completed",
                payload: { session },
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

        const firstQuestion = await planAiOnboardingQuestion({
          endpoint,
          modelId: resolvedModelId,
          answers: initialAnswers,
          summary: seededSummary,
        });

        summary = buildOnboardingSummary(initialAnswers, {
          mode: "ai_dynamic",
          runtime,
          dynamicHistory: [firstQuestion],
        });
      }
    }

    const session = await createSerializedOnboardingSession({
      userId: user.id,
      status,
      currentQuestionIndex,
      answers: toPrismaJson(initialAnswers),
      summary: toPrismaJson(summary),
    });

    return jsonCreated({ session });
  } catch (error) {
    return jsonError(error);
  }
}
