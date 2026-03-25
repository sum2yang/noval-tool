import { prisma } from "@/lib/db";
import { jsonError, jsonOk } from "@/lib/api/http";
import { resolveRequestUser } from "@/lib/auth/identity";
import { toPrismaJson } from "@/lib/prisma-json";
import { normalizeApiPresets } from "@/lib/projects/api-presets";

async function clearEndpointReferencesForUser(userId: string, endpointId: string) {
  const preferences = await prisma.projectPreference.findMany({
    where: {
      project: {
        userId,
      },
    },
    select: {
      id: true,
      defaultEndpointId: true,
      apiPresets: true,
    },
  });

  const updates = preferences.flatMap((preference) => {
    const currentApiPresets = normalizeApiPresets(preference.apiPresets, { fallbackToDefaults: false });
    let presetChanged = false;
    const nextApiPresets = currentApiPresets.map((preset) => {
      if (preset.endpointId !== endpointId) {
        return preset;
      }

      presetChanged = true;
      return {
        ...preset,
        endpointId: null,
      };
    });
    const shouldClearDefaultEndpoint = preference.defaultEndpointId === endpointId;

    if (!presetChanged && !shouldClearDefaultEndpoint) {
      return [];
    }

    return [
      prisma.projectPreference.update({
        where: {
          id: preference.id,
        },
        data: {
          defaultEndpointId: shouldClearDefaultEndpoint ? null : preference.defaultEndpointId,
          apiPresets: toPrismaJson(nextApiPresets),
        },
      }),
    ];
  });

  if (updates.length > 0) {
    await Promise.all(updates);
  }
}

export async function DELETE(
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
      select: {
        id: true,
        label: true,
      },
    });

    if (!endpoint) {
      return Response.json({ error: { code: "NOT_FOUND", message: "Endpoint not found." } }, { status: 404 });
    }

    const linkedRun = await prisma.generationRun.findFirst({
      where: {
        endpointId: endpoint.id,
      },
      select: {
        id: true,
      },
    });

    await clearEndpointReferencesForUser(user.id, endpoint.id);

    if (linkedRun) {
      await prisma.providerEndpoint.update({
        where: { id: endpoint.id },
        data: {
          archivedAt: new Date(),
        },
      });

      return jsonOk({
        removed: true,
        archived: true,
        id: endpoint.id,
      });
    }

    await prisma.providerEndpoint.delete({
      where: { id: endpoint.id },
    });

    return jsonOk({
      removed: true,
      archived: false,
      id: endpoint.id,
    });
  } catch (error) {
    return jsonError(error);
  }
}
