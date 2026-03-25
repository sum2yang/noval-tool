import { prisma } from "@/lib/db";
import { jsonError, jsonOk } from "@/lib/api/http";
import { resolveRequestUser } from "@/lib/auth/identity";
import { probeEndpoint } from "@/lib/providers/factory";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const [{ id }, user] = await Promise.all([params, resolveRequestUser(request)]);
    const endpoint = await prisma.providerEndpoint.findFirst({
      where: {
        id,
        userId: user.id,
        archivedAt: null,
      },
    });

    if (!endpoint) {
      return Response.json({ error: { code: "NOT_FOUND", message: "Endpoint not found." } }, { status: 404 });
    }

    const probe = await probeEndpoint(endpoint);

    await prisma.providerEndpoint.update({
      where: { id: endpoint.id },
      data: {
        healthStatus: probe.status,
        lastHealthCheckAt: new Date(),
      },
    });

    return jsonOk(probe);
  } catch (error) {
    return jsonError(error);
  }
}
