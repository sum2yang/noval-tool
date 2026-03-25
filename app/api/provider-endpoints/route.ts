import { prisma } from "@/lib/db";
import { jsonCreated, jsonError, jsonOk, parseJson } from "@/lib/api/http";
import { providerEndpointInputSchema } from "@/lib/api/schemas";
import { resolveRequestUser } from "@/lib/auth/identity";
import { encryptRecord, encryptString } from "@/lib/security/crypto";
import { assertSafeRemoteUrl } from "@/lib/security/url";

export async function GET(request: Request) {
  try {
    const user = await resolveRequestUser(request);
    const endpoints = await prisma.providerEndpoint.findMany({
      where: {
        userId: user.id,
        archivedAt: null,
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        providerType: true,
        openaiApiStyle: true,
        label: true,
        baseURL: true,
        authMode: true,
        defaultModel: true,
        healthStatus: true,
        lastHealthCheckAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return jsonOk({ items: endpoints });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await resolveRequestUser(request);
    const payload = await parseJson(request, providerEndpointInputSchema);
    assertSafeRemoteUrl(payload.baseURL);

    const endpoint = await prisma.providerEndpoint.create({
      data: {
        userId: user.id,
        providerType: payload.providerType,
        openaiApiStyle: payload.openaiApiStyle,
        label: payload.label,
        baseURL: payload.baseURL,
        authMode: payload.authMode,
        encryptedSecret: payload.secret ? encryptString(payload.secret) : "",
        encryptedHeaders: encryptRecord(payload.extraHeaders),
        defaultModel: payload.defaultModel,
      },
      select: {
        id: true,
        providerType: true,
        openaiApiStyle: true,
        label: true,
        baseURL: true,
        authMode: true,
        defaultModel: true,
        healthStatus: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return jsonCreated(endpoint);
  } catch (error) {
    return jsonError(error);
  }
}
