import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("generation compose helpers", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("@/lib/knowledge");
  });

  it("resolves prompt routing and skill composition from knowledge assets", async () => {
    const { resolveTaskDefinition } = await import("./compose");

    const definition = await resolveTaskDefinition("review_content");

    expect(definition.task.taskType).toBe("review_content");
    expect(definition.task.supportsMcp).toBe(true);
    expect(definition.task.supportsSearch).toBe(true);
    expect(definition.prompt.promptFile).toBe("review_content.md");
    expect(definition.prompt.outputContract).toBe("问题 -> 证据 -> 最小修法");
    expect(definition.skills.skills).toEqual(["reviewer", "researcher"]);
  });

  it("injects context, references, MCP tools, skills, and output contract into the resolved prompt", async () => {
    const { composeResolvedPrompt } = await import("./compose");

    const result = await composeResolvedPrompt({
      taskType: "review_content",
      userInstruction: "请审查这一章的设定冲突和事实错误。",
      projectPromptOverlay: "# project prompt pack\n强调交易收益链和港岛势力秩序，禁写无收益抒情。",
      projectContext: "# current_state\n主角已抵达九州城。",
      projectSkillOverlay: "# project skill pack\nReviewer 额外关注考据冲突和收益链断点。",
      selectedReferences: "# archive\n九州城商贸记录",
      selectedMcpTools: "smoke_mcp__lookup_fact",
      externalFacts: "港口在秋季货运繁忙。",
      externalPromptTemplate: "## user\n请先调用 lookup_fact，再输出审稿结论。",
      externalPromptLabel: "Smoke MCP / review_with_fact",
      currentTime: "2026-03-20T00:00:00.000Z",
    });

    expect(result.promptFile).toBe("review_content.md");
    expect(result.outputContract).toBe("问题 -> 证据 -> 最小修法");
    expect(result.resolvedSkills.map((skill) => skill.name)).toEqual(["reviewer", "researcher", "project_skill_pack"]);
    expect(result.resolvedPrompt).toContain("请审查这一章的设定冲突和事实错误。");
    expect(result.resolvedPrompt).toContain("项目专属 Prompt Overlay");
    expect(result.resolvedPrompt).toContain("强调交易收益链和港岛势力秩序");
    expect(result.resolvedPrompt).toContain("主角已抵达九州城。");
    expect(result.resolvedPrompt).toContain("九州城商贸记录");
    expect(result.resolvedPrompt).toContain("smoke_mcp__lookup_fact");
    expect(result.resolvedPrompt).toContain("港口在秋季货运繁忙。");
    expect(result.resolvedPrompt).toContain("项目专属 Skill Overlay");
    expect(result.resolvedPrompt).toContain("Reviewer 额外关注考据冲突和收益链断点。");
    expect(result.resolvedPrompt).toContain("外部提示模板（运行时注入）");
    expect(result.resolvedPrompt).toContain("Smoke MCP / review_with_fact");
    expect(result.resolvedPrompt).toContain("请先调用 lookup_fact，再输出审稿结论。");
    expect(result.resolvedPrompt).toContain("问题 -> 证据 -> 最小修法");
    expect(result.resolvedPrompt).toContain("# reviewer");
    expect(result.resolvedPrompt).toContain("# researcher");
    expect(result.resolvedPrompt).toContain("2026-03-20T00:00:00.000Z");
  });

  it("falls back to the configured fallback prompt when the primary prompt file is missing", async () => {
    const knowledgeModule = await import("@/lib/knowledge");
    vi.spyOn(knowledgeModule, "loadKnowledgeBase").mockResolvedValue({
        canonical: {},
        prompts: {
          "fallback.md": "Fallback prompt: {{user_instruction}}",
        },
        skills: {
          "reviewer.md": "Find the issue.",
        },
        schemas: {
          "task-types.json": [
            {
              taskType: "review_content",
              label: "内容审稿",
              description: "test",
              requiresArtifacts: [],
              supportsMcp: true,
              supportsSearch: true,
              outputContract: "问题 -> 证据 -> 最小修法",
            },
          ],
          "prompt-routing.json": [
            {
              taskType: "review_content",
              promptFile: "missing.md",
              fallbackPromptFile: "fallback.md",
              outputContract: "问题 -> 证据 -> 最小修法",
            },
          ],
          "skill-composition.json": [
            {
              taskType: "review_content",
              skills: ["reviewer"],
              notes: "test",
            },
          ],
        },
      });
    vi.spyOn(knowledgeModule, "getKnowledgeDigest").mockResolvedValue("digest");

    const { composeResolvedPrompt } = await import("./compose");
    const result = await composeResolvedPrompt({
      taskType: "review_content",
      userInstruction: "fallback case",
      projectContext: "ctx",
      currentTime: "2026-03-20T00:00:00.000Z",
    });

    expect(result.promptFile).toBe("missing.md");
    expect(result.resolvedPrompt).toContain("Fallback prompt: fallback case");
  });
});
