import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { IntegrationSettingsShell } from "@/components/settings/integration-settings-shell";
import { resolveHeadersUser } from "@/lib/auth/identity";
import { prisma } from "@/lib/db";
import { getGrokStatusSummary } from "@/lib/search/grok-config";

export default async function SettingsPage() {
  const user = await resolveHeadersUser(await headers()).catch(() => null);

  if (!user) {
    redirect("/login");
  }

  const [endpoints, mcpServers] = await Promise.all([
    prisma.providerEndpoint.findMany({
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
        updatedAt: true,
      },
    }),
    prisma.mcpServer.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        name: true,
        transportType: true,
        serverUrl: true,
        authMode: true,
        toolCount: true,
        resourceCount: true,
        promptCount: true,
        healthStatus: true,
        lastSyncAt: true,
        updatedAt: true,
      },
    }),
  ]);

  const grokStatus = await getGrokStatusSummary(user.id);

  return (
    <IntegrationSettingsShell
      profile={{
        name: user.name,
        email: user.email,
      }}
      endpoints={endpoints}
      mcpServers={mcpServers}
      grokStatus={grokStatus}
    />
  );
}
