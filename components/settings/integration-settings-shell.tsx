"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { SectionPanel } from "@/components/section-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  getAuthModeLabel,
  getMcpTransportTypeLabel,
  getOpenAIApiStyleLabel,
  getProviderTypeLabel,
} from "@/lib/integrations/display-labels";
import { getHealthStatusLabel } from "@/lib/integrations/health-status";
import { AUTH_MODES, MCP_TRANSPORT_TYPES, OPENAI_API_STYLES, PROVIDER_TYPES } from "@/lib/types/domain";

type ProviderEndpointItem = {
  id: string;
  providerType: string;
  openaiApiStyle: string;
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

type GrokStatusSummary = {
  source: "user" | "env" | "mixed" | "none";
  enabled: boolean;
  grokApiUrl: string;
  grokModel: string;
  hasGrokApiKey: boolean;
  grokSource: "user" | "env" | "none";
  tavilyApiUrl: string;
  hasTavilyApiKey: boolean;
  tavilySource: "user" | "env" | "none";
  firecrawlApiUrl: string;
  hasFirecrawlApiKey: boolean;
  firecrawlSource: "user" | "env" | "none";
  hasPlatformFallback: boolean;
  canSearch: boolean;
  canFetch: boolean;
  canMap: boolean;
  healthStatus: string | null;
  lastHealthCheckAt?: string | Date | null;
  retryMaxAttempts: number;
  retryMultiplier: number;
  retryMaxWait: number;
};

function formatTime(value: string | Date | null | undefined) {
  if (!value) {
    return "未检查";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function parseHeadersInput(raw: FormDataEntryValue | null) {
  if (typeof raw !== "string" || !raw.trim()) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("额外请求头必须是合法 JSON。");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("额外请求头必须是对象。");
  }

  const entries = Object.entries(parsed);
  for (const [, value] of entries) {
    if (typeof value !== "string") {
      throw new Error("额外请求头的值必须是字符串。");
    }
  }

  return Object.fromEntries(entries);
}

async function readErrorMessage(response: Response) {
  const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return payload?.error?.message ?? "请求失败。";
}

export function IntegrationSettingsShell({
  profile,
  endpoints,
  mcpServers,
  grokStatus,
}: {
  profile: {
    name?: string | null;
    email?: string | null;
  };
  endpoints: ProviderEndpointItem[];
  mcpServers: McpServerItem[];
  grokStatus: GrokStatusSummary;
}) {
  const router = useRouter();
  const [endpointProviderType, setEndpointProviderType] = useState("openai");
  const [endpointError, setEndpointError] = useState<string | null>(null);
  const [endpointMessage, setEndpointMessage] = useState<string | null>(null);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpMessage, setMcpMessage] = useState<string | null>(null);
  const [grokError, setGrokError] = useState<string | null>(null);
  const [grokMessage, setGrokMessage] = useState<string | null>(null);
  const [healthMessage, setHealthMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function runRefresh(action: () => Promise<void>) {
    startTransition(async () => {
      try {
        await action();
        router.refresh();
      } catch (error) {
        setHealthMessage(error instanceof Error ? error.message : "请求失败。");
      }
    });
  }

  async function handleEndpointSubmit(formData: FormData) {
    setEndpointError(null);
    setEndpointMessage(null);

    const response = await fetch("/api/provider-endpoints", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        providerType: String(formData.get("providerType") ?? "openai"),
        openaiApiStyle: String(formData.get("openaiApiStyle") ?? "responses"),
        label: String(formData.get("label") ?? "").trim(),
        baseURL: String(formData.get("baseURL") ?? "").trim(),
        authMode: String(formData.get("authMode") ?? "bearer"),
        secret: String(formData.get("secret") ?? "").trim() || undefined,
        extraHeaders: parseHeadersInput(formData.get("extraHeaders")),
        defaultModel: String(formData.get("defaultModel") ?? "").trim(),
      }),
    });

    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }

    setEndpointMessage("模型接口已保存。");
  }

  async function handleMcpSubmit(formData: FormData) {
    setMcpError(null);
    setMcpMessage(null);

    const response = await fetch("/api/mcp-servers", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: String(formData.get("name") ?? "").trim(),
        transportType: String(formData.get("transportType") ?? "streamable_http"),
        serverUrl: String(formData.get("serverUrl") ?? "").trim(),
        authMode: String(formData.get("authMode") ?? "none"),
        authPayload: String(formData.get("authPayload") ?? "").trim() || undefined,
        extraHeaders: parseHeadersInput(formData.get("extraHeaders")),
      }),
    });

    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }

    setMcpMessage("MCP 服务已保存。");
  }

  async function handleGrokSubmit(formData: FormData) {
    setGrokError(null);
    setGrokMessage(null);

    const response = await fetch("/api/grok-config", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        grokApiUrl: String(formData.get("grokApiUrl") ?? "").trim(),
        grokApiKey: String(formData.get("grokApiKey") ?? "").trim() || undefined,
        grokModel: String(formData.get("grokModel") ?? "").trim(),
        tavilyApiUrl: String(formData.get("tavilyApiUrl") ?? "").trim(),
        tavilyApiKey: String(formData.get("tavilyApiKey") ?? "").trim() || undefined,
        firecrawlApiUrl: String(formData.get("firecrawlApiUrl") ?? "").trim(),
        firecrawlApiKey: String(formData.get("firecrawlApiKey") ?? "").trim() || undefined,
      }),
    });

    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }

    setGrokMessage("GrokSearch 配置已保存。");
  }

  function getGrokSourceLabel(source: GrokStatusSummary["source"] | GrokStatusSummary["grokSource"]) {
    switch (source) {
      case "user":
        return "当前使用个人配置";
      case "mixed":
        return "当前使用混合来源";
      case "env":
        return "当前使用平台默认";
      default:
        return "当前未配置";
    }
  }

  function getGrokHealthLabel() {
    if (!grokStatus.healthStatus) {
      return grokStatus.source === "env" ? "平台默认未单独检查" : "未检查";
    }

    return getHealthStatusLabel(grokStatus.healthStatus);
  }

  const grokFormRefreshKey = [
    grokStatus.source,
    grokStatus.grokApiUrl,
    grokStatus.grokModel,
    grokStatus.tavilyApiUrl,
    grokStatus.firecrawlApiUrl,
    grokStatus.healthStatus ?? "none",
    grokStatus.lastHealthCheckAt ? new Date(grokStatus.lastHealthCheckAt).toISOString() : "never",
  ].join("|");
  const hasUserGrokConfig =
    grokStatus.grokSource === "user" ||
    grokStatus.tavilySource === "user" ||
    grokStatus.firecrawlSource === "user";

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
      <SectionPanel
        title="个人资料卡"
        description="这里集中展示当前登录身份，以及模型接口、MCP 与 GrokSearch 的使用入口。"
        className="xl:col-span-2"
      >
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4">
            <p className="text-xs tracking-[0.14em] uppercase text-[var(--muted-ink)]">当前昵称</p>
            <p className="mt-2 text-sm text-[var(--ink)]">{profile.name?.trim() || "未设置昵称"}</p>
          </div>
          <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4">
            <p className="text-xs tracking-[0.14em] uppercase text-[var(--muted-ink)]">登录邮箱</p>
            <p className="mt-2 text-sm text-[var(--ink)]">{profile.email?.trim() || "未绑定邮箱"}</p>
          </div>
          <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4">
            <p className="text-xs tracking-[0.14em] uppercase text-[var(--muted-ink)]">当前工作入口</p>
            <p className="mt-2 text-sm text-[var(--ink)]">项目列表 / 模型接口 / MCP / GrokSearch</p>
          </div>
        </div>
      </SectionPanel>

      <SectionPanel title="模型接口" description="真实读取并创建 OpenAI / Gemini / Anthropic 接口。">
        <div className="space-y-4">
          <form
            className="space-y-4 rounded-[24px] border border-[var(--line)] bg-[var(--paper)] p-4"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              runRefresh(async () => {
                try {
                  await handleEndpointSubmit(new FormData(form));
                  form.reset();
                  setEndpointProviderType("openai");
                } catch (error) {
                  setEndpointError(error instanceof Error ? error.message : "模型接口保存失败。");
                }
              });
            }}
          >
            <div className="grid gap-4 md:grid-cols-3">
              <Select
                name="providerType"
                defaultValue="openai"
                onChange={(event) => setEndpointProviderType(event.currentTarget.value)}
              >
                {PROVIDER_TYPES.map((providerType) => (
                  <option key={providerType} value={providerType}>
                    {getProviderTypeLabel(providerType)}
                  </option>
                ))}
              </Select>
              <Select name="authMode" defaultValue="bearer">
                {AUTH_MODES.map((authMode) => (
                  <option key={authMode} value={authMode}>
                    {getAuthModeLabel(authMode)}
                  </option>
                ))}
              </Select>
              <Select
                name="openaiApiStyle"
                defaultValue="responses"
                disabled={endpointProviderType !== "openai"}
                aria-label="OpenAI API 模式"
              >
                {OPENAI_API_STYLES.map((apiStyle) => (
                  <option key={apiStyle} value={apiStyle}>
                    {getOpenAIApiStyleLabel(apiStyle)}
                  </option>
                ))}
              </Select>
            </div>
            <p className="text-xs text-[var(--muted-ink)]">
              仅 OpenAI 需要选择接口模式。兼容 `/v1/chat/completions` 的上游，请切到 Chat Completions API。
            </p>
            <Input name="label" placeholder="显示名称，例如 OpenAI Production" required />
            <Input name="baseURL" type="url" placeholder="https://api.openai.com/v1" required />
            <Input name="defaultModel" placeholder="默认模型，例如 gpt-5" required />
            <Input name="secret" type="password" placeholder="认证密钥，authMode=none 时可留空" />
            <Textarea name="extraHeaders" placeholder='额外请求头，JSON 格式，例如 {"x-foo":"bar"}' />
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-[var(--muted-ink)]">
                健康检查只会对默认模型发起一次最小探活，不等于大上下文生成一定成功。
              </p>
              <Button type="submit" size="sm" disabled={isPending}>
                {isPending ? "保存中" : "保存接口"}
              </Button>
            </div>
            {endpointError ? <p className="text-sm text-[#9f3a2f]">{endpointError}</p> : null}
            {endpointMessage ? <p className="text-sm text-[#556d59]">{endpointMessage}</p> : null}
          </form>

          <div className="space-y-3">
            {endpoints.length === 0 ? (
              <div className="rounded-[20px] border border-dashed border-[var(--line)] bg-[var(--paper)] p-4 text-sm text-[var(--muted-ink)]">
                还没有保存模型接口。
              </div>
            ) : null}
            {endpoints.map((endpoint) => (
              <div key={endpoint.id} className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-[var(--ink)]">{endpoint.label}</p>
                    <p className="mt-1 text-xs text-[var(--muted-ink)]">
                      {getProviderTypeLabel(endpoint.providerType)}
                      {endpoint.providerType === "openai"
                        ? ` · ${getOpenAIApiStyleLabel(endpoint.openaiApiStyle)}`
                        : ""}
                      {" · "}
                      {endpoint.defaultModel}
                    </p>
                    <p className="mt-1 text-xs text-[var(--muted-ink)]">鉴权方式：{getAuthModeLabel(endpoint.authMode)}</p>
                    <p className="mt-1 truncate text-xs text-[var(--muted-ink)]">{endpoint.baseURL}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={isPending}
                      onClick={() =>
                        runRefresh(async () => {
                          const response = await fetch(`/api/provider-endpoints/${endpoint.id}/health`, {
                            method: "POST",
                          });
                          if (!response.ok) {
                            throw new Error(await readErrorMessage(response));
                          }
                          setHealthMessage(`已检查模型接口 ${endpoint.label}。`);
                        })
                      }
                    >
                      健康检查
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={isPending}
                      onClick={() => {
                        const confirmed = window.confirm(
                          `确定删除模型接口“${endpoint.label}”吗？\n\n如果它已经被历史生成记录引用，系统会阻止删除。`,
                        );

                        if (!confirmed) {
                          return;
                        }

                        runRefresh(async () => {
                          const response = await fetch(`/api/provider-endpoints/${endpoint.id}`, {
                            method: "DELETE",
                          });
                          if (!response.ok) {
                            throw new Error(await readErrorMessage(response));
                          }
                          const payload = (await response.json().catch(() => null)) as { archived?: boolean } | null;
                          setEndpointMessage(
                            payload?.archived
                              ? `已移除模型接口 ${endpoint.label}。历史运行仍会保留，当前接口已从可用列表隐藏。`
                              : `已删除模型接口 ${endpoint.label}。`,
                          );
                        });
                      }}
                    >
                      删除
                    </Button>
                  </div>
                </div>
                <p className="mt-3 text-xs text-[var(--muted-ink)]">
                  状态：{getHealthStatusLabel(endpoint.healthStatus)} · 最近检查：{formatTime(endpoint.lastHealthCheckAt)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </SectionPanel>

      <SectionPanel title="远程 MCP 服务" description="真实读取并创建远程 MCP 服务，支持健康检查。">
        <div className="space-y-4">
          <form
            className="space-y-4 rounded-[24px] border border-[var(--line)] bg-[var(--paper)] p-4"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              runRefresh(async () => {
                try {
                  await handleMcpSubmit(new FormData(form));
                  form.reset();
                } catch (error) {
                  setMcpError(error instanceof Error ? error.message : "MCP 服务保存失败。");
                }
              });
            }}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <Select name="transportType" defaultValue="streamable_http">
                {MCP_TRANSPORT_TYPES.map((transportType) => (
                  <option key={transportType} value={transportType}>
                    {getMcpTransportTypeLabel(transportType)}
                  </option>
                ))}
              </Select>
              <Select name="authMode" defaultValue="none">
                {AUTH_MODES.map((authMode) => (
                  <option key={authMode} value={authMode}>
                    {getAuthModeLabel(authMode)}
                  </option>
                ))}
              </Select>
            </div>
            <Input name="name" placeholder="服务名称" required />
            <Input name="serverUrl" type="url" placeholder="https://mcp.example.com" required />
            <Input name="authPayload" type="password" placeholder="认证载荷，可选" />
            <Textarea name="extraHeaders" placeholder='额外请求头，JSON 格式，例如 {"x-tenant":"novel"}' />
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-[var(--muted-ink)]">保存后可探测工具、资料和提示模板的能力快照。</p>
              <Button type="submit" size="sm" disabled={isPending}>
                {isPending ? "保存中" : "保存 MCP 服务"}
              </Button>
            </div>
            {mcpError ? <p className="text-sm text-[#9f3a2f]">{mcpError}</p> : null}
            {mcpMessage ? <p className="text-sm text-[#556d59]">{mcpMessage}</p> : null}
          </form>

          <div className="space-y-3">
            {mcpServers.length === 0 ? (
              <div className="rounded-[20px] border border-dashed border-[var(--line)] bg-[var(--paper)] p-4 text-sm text-[var(--muted-ink)]">
                还没有保存 MCP 服务。
              </div>
            ) : null}
            {mcpServers.map((server) => (
              <div key={server.id} className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-[var(--ink)]">{server.name}</p>
                    <p className="mt-1 text-xs text-[var(--muted-ink)]">
                      {getMcpTransportTypeLabel(server.transportType)} · {server.toolCount} 个工具 · {server.resourceCount} 份资料 · {server.promptCount} 个模板
                    </p>
                    <p className="mt-1 text-xs text-[var(--muted-ink)]">鉴权方式：{getAuthModeLabel(server.authMode)}</p>
                    <p className="mt-1 truncate text-xs text-[var(--muted-ink)]">{server.serverUrl}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={isPending}
                      onClick={() =>
                        runRefresh(async () => {
                          const response = await fetch(`/api/mcp-servers/${server.id}/health`, {
                            method: "POST",
                          });
                          if (!response.ok) {
                            throw new Error(await readErrorMessage(response));
                          }
                          setHealthMessage(`已检查 MCP 服务 ${server.name}。`);
                        })
                      }
                    >
                      健康检查
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={isPending}
                      onClick={() => {
                        const confirmed = window.confirm(
                          `确定删除 MCP 服务“${server.name}”吗？\n\n删除后，该服务将不再出现在任务选择与能力浏览中。`,
                        );

                        if (!confirmed) {
                          return;
                        }

                        runRefresh(async () => {
                          const response = await fetch(`/api/mcp-servers/${server.id}`, {
                            method: "DELETE",
                          });
                          if (!response.ok) {
                            throw new Error(await readErrorMessage(response));
                          }
                          setMcpMessage(`已删除 MCP 服务 ${server.name}。`);
                        });
                      }}
                    >
                      删除
                    </Button>
                  </div>
                </div>
                <p className="mt-3 text-xs text-[var(--muted-ink)]">
                  状态：{getHealthStatusLabel(server.healthStatus)} · 最近同步：{formatTime(server.lastSyncAt)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </SectionPanel>

      <SectionPanel title="GrokSearch" description="平台内会按你的 Grok / Tavily / Firecrawl 上游配置直接执行检索、抓取和来源缓存。">
        <div className="space-y-4 text-sm leading-7 text-[var(--ink-soft)]">
          <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm text-[var(--ink)]">当前接入状态</p>
                <p className="mt-2 text-xs text-[var(--muted-ink)]">
                  {grokStatus.enabled ? getGrokSourceLabel(grokStatus.source) : "当前既没有个人配置，也没有平台默认可回退。"}
                </p>
              </div>
              <span
                className={`rounded-full border px-3 py-1 text-xs ${
                  grokStatus.canSearch || grokStatus.canFetch
                    ? "border-[#b7d1bd] bg-[rgba(85,109,89,0.08)] text-[#556d59]"
                    : "border-[#d9c79c] bg-[rgba(191,152,69,0.10)] text-[#7f5f1d]"
                }`}
              >
                {grokStatus.canSearch || grokStatus.canFetch ? "可用" : "待补齐"}
              </span>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <div className="rounded-[16px] border border-[var(--line)] p-3 text-xs text-[var(--ink-soft)]">
                <p className="text-[var(--ink)]">Grok</p>
                <p className="mt-1 break-all">API URL：{grokStatus.grokApiUrl || "未配置"}</p>
                <p>模型：{grokStatus.grokModel || "未配置"}</p>
                <p>访问密钥：{grokStatus.hasGrokApiKey ? "已保存" : "未配置"}</p>
                <p>来源：{getGrokSourceLabel(grokStatus.grokSource)}</p>
              </div>
              <div className="rounded-[16px] border border-[var(--line)] p-3 text-xs text-[var(--ink-soft)]">
                <p className="text-[var(--ink)]">Tavily</p>
                <p className="mt-1 break-all">API URL：{grokStatus.tavilyApiUrl || "未配置"}</p>
                <p>访问密钥：{grokStatus.hasTavilyApiKey ? "已保存" : "未配置"}</p>
                <p>来源：{getGrokSourceLabel(grokStatus.tavilySource)}</p>
              </div>
              <div className="rounded-[16px] border border-[var(--line)] p-3 text-xs text-[var(--ink-soft)]">
                <p className="text-[var(--ink)]">Firecrawl</p>
                <p className="mt-1 break-all">API URL：{grokStatus.firecrawlApiUrl || "未配置"}</p>
                <p>访问密钥：{grokStatus.hasFirecrawlApiKey ? "已保存" : "未配置"}</p>
                <p>来源：{getGrokSourceLabel(grokStatus.firecrawlSource)}</p>
              </div>
            </div>

            <div className="mt-4 rounded-[16px] border border-[var(--line)] p-3 text-xs text-[var(--ink-soft)]">
              <p>健康状态：{getGrokHealthLabel()} · 最近检查：{formatTime(grokStatus.lastHealthCheckAt)}</p>
              <p>
                当前能力：
                {[
                  grokStatus.canSearch ? "联网检索" : null,
                  grokStatus.canFetch ? "网页抓取" : null,
                  grokStatus.canMap ? "站点映射" : null,
                ]
                  .filter(Boolean)
                  .join(" / ") || "尚未具备可用搜索能力"}
              </p>
              <p>
                重试参数：{grokStatus.retryMaxAttempts} 次 / 倍率 {grokStatus.retryMultiplier} / 最大等待 {grokStatus.retryMaxWait}ms
              </p>
            </div>
          </div>

          <form
            key={grokFormRefreshKey}
            className="space-y-4 rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              runRefresh(async () => {
                try {
                  await handleGrokSubmit(new FormData(form));
                } catch (error) {
                  setGrokError(error instanceof Error ? error.message : "GrokSearch 配置保存失败。");
                }
              });
            }}
          >
            <p className="text-sm text-[var(--ink)]">保存个人上游配置</p>
            <div className="grid gap-4 md:grid-cols-2">
              <Input
                name="grokApiUrl"
                type="url"
                defaultValue={grokStatus.grokSource === "user" ? grokStatus.grokApiUrl : ""}
                placeholder="GROK_API_URL，例如 https://api.x.ai/v1"
                required
              />
              <Input
                name="grokModel"
                defaultValue={grokStatus.grokSource === "user" ? grokStatus.grokModel : ""}
                placeholder="GROK_MODEL，例如 grok-4-fast"
                required
              />
            </div>
            <Input
              name="grokApiKey"
              type="password"
              placeholder={grokStatus.grokSource === "user" ? "留空则保留当前 GROK_API_KEY" : "首次保存个人 Grok 配置时必填"}
            />
            <div className="grid gap-4 md:grid-cols-2">
              <Input
                name="tavilyApiUrl"
                type="url"
                defaultValue={grokStatus.tavilySource === "user" ? grokStatus.tavilyApiUrl : ""}
                placeholder="TAVILY_API_URL，可留空以回退平台默认"
              />
              <Input
                name="tavilyApiKey"
                type="password"
                placeholder={grokStatus.tavilySource === "user" ? "留空则保留当前 TAVILY_API_KEY" : "首次保存 Tavily 时必填；可留空不用个人 Tavily"}
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Input
                name="firecrawlApiUrl"
                type="url"
                defaultValue={grokStatus.firecrawlSource === "user" ? grokStatus.firecrawlApiUrl : ""}
                placeholder="FIRECRAWL_API_URL，可留空以回退平台默认"
              />
              <Input
                name="firecrawlApiKey"
                type="password"
                placeholder={grokStatus.firecrawlSource === "user" ? "留空则保留当前 FIRECRAWL_API_KEY" : "首次保存 Firecrawl 时必填；可留空不用个人 Firecrawl"}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs leading-6 text-[var(--muted-ink)]">
                这里保存的是你自己的上游 API 信息，不再要求你额外部署一个预接好的 GrokSearch 服务。健康检查会发起最小探测，可能消耗少量第三方额度。
              </p>
              <div className="flex flex-wrap items-center gap-3">
                {hasUserGrokConfig ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={isPending}
                    onClick={() =>
                      runRefresh(async () => {
                        const response = await fetch("/api/grok-config", {
                          method: "DELETE",
                        });
                        if (!response.ok) {
                          throw new Error(await readErrorMessage(response));
                        }
                        setGrokMessage("已移除个人 GrokSearch 配置。");
                      })
                    }
                  >
                    回退平台默认
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={isPending || !grokStatus.enabled}
                  onClick={() =>
                    runRefresh(async () => {
                      const response = await fetch("/api/grok-config/health", {
                        method: "POST",
                      });
                      if (!response.ok) {
                        throw new Error(await readErrorMessage(response));
                      }
                      setGrokMessage("已完成 GrokSearch 健康检查。");
                    })
                  }
                >
                  健康检查
                </Button>
                <Button type="submit" size="sm" disabled={isPending}>
                  {isPending ? "保存中" : "保存 GrokSearch"}
                </Button>
              </div>
            </div>
            {grokError ? <p className="text-sm text-[#9f3a2f]">{grokError}</p> : null}
            {grokMessage ? <p className="text-sm text-[#556d59]">{grokMessage}</p> : null}
          </form>

          <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4">
            <p className="text-sm text-[var(--ink)]">作者怎么使用</p>
            <ul className="mt-2 space-y-2 text-xs leading-6 text-[var(--ink-soft)]">
              <li>1. 在“任务执行”里选择“考据核查”，系统会优先走 Tavily 检索，再用 Grok 整理摘要。</li>
              <li>2. 如果某次搜索返回了 `sessionId`，你可以在运行诊断里继续查看来源明细并下载 JSON。</li>
              <li>3. 需要网页抓取或站点映射时，平台会使用 Firecrawl。</li>
              <li>4. 外部事实只会进入草稿或引用区，不会直接覆盖剧情正式稿。</li>
            </ul>
          </div>
          {grokStatus.hasPlatformFallback ? (
            <div className="rounded-[20px] border border-[var(--line)] bg-[var(--paper)] p-4 text-xs leading-6 text-[var(--ink-soft)]">
              平台当前仍保留默认 Grok / Tavily / Firecrawl 回退配置。你没有填写的字段，会逐项回退到平台默认。
            </div>
          ) : null}
          {healthMessage ? <p className="text-sm text-[#556d59]">{healthMessage}</p> : null}
        </div>
      </SectionPanel>

      <SectionPanel title="安全约束" description="所有自定义 URL 和 MCP URL 都按 SSRF 风险处理。">
        <ul className="space-y-3 text-sm leading-7 text-[var(--ink-soft)]">
          <li>1. 生产环境仅允许 `https`。</li>
          <li>2. 拦截 `localhost`、私网地址与 metadata 地址。</li>
          <li>3. 密钥与认证载荷服务端加密存储，不回显明文。</li>
          <li>4. 所有外部输出先进入草稿，再由用户确认回填。</li>
        </ul>
      </SectionPanel>
    </div>
  );
}
