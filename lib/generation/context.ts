import "server-only";

import type { ReferenceDocument, WorkspaceArtifact, WorkspaceArtifactRevision } from "@prisma/client";

type ArtifactWithRevision = WorkspaceArtifact & {
  currentRevision: WorkspaceArtifactRevision | null;
};

type DraftOverlay = {
  artifactId: string;
  outputContent: string;
};

const MAX_ARTIFACT_CONTEXT_CHARS_TOTAL = 18000;
const MAX_ARTIFACT_CONTEXT_CHARS_PER_FILE = 6000;
const SEGMENT_COMPRESSION_NOTICE = "[已分段压缩，保留结构锚点与段首摘要，完整正文请回到项目文件查看]";
const TRUNCATION_NOTICE = "\n\n[已截断，避免项目文件上下文过长导致生成失败]";
const SKIP_NOTICE = "[已跳过，避免项目文件上下文过长导致生成失败]";
const MIN_FILE_CONTEXT_CHARS = 240;
const MAX_SEGMENTS = 8;
const MIN_SEGMENT_CHARS = 120;

type ContextSegment = {
  heading: string | null;
  content: string;
};

function normalizeContextText(value: string) {
  return value.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function trimArtifactContext(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength).trimEnd()}${TRUNCATION_NOTICE}`;
}

function splitMarkdownSegments(value: string) {
  const normalized = normalizeContextText(value);
  const lines = normalized.split("\n");
  const segments: ContextSegment[] = [];
  let currentHeading: string | null = null;
  let currentContent: string[] = [];

  const pushSegment = () => {
    const content = normalizeContextText(currentContent.join("\n"));
    if (!content) {
      return;
    }

    segments.push({
      heading: currentHeading,
      content,
    });
  };

  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line.trim())) {
      pushSegment();
      currentHeading = line.trim();
      currentContent = [];
      continue;
    }

    currentContent.push(line);
  }

  pushSegment();

  if (segments.length > 0) {
    return segments;
  }

  return normalized
    .split(/\n{2,}/)
    .map((item) => normalizeContextText(item))
    .filter(Boolean)
    .map((content) => ({
      heading: null,
      content,
    }));
}

function buildCompressedArtifactContext(value: string, maxLength: number) {
  if (maxLength <= MIN_FILE_CONTEXT_CHARS) {
    return SKIP_NOTICE;
  }

  const normalized = normalizeContextText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const segments = splitMarkdownSegments(normalized).slice(0, MAX_SEGMENTS);
  if (segments.length === 0) {
    return trimArtifactContext(normalized, maxLength);
  }

  const intro = `${SEGMENT_COMPRESSION_NOTICE}\n\n`;
  const availableLength = maxLength - intro.length;
  if (availableLength <= MIN_FILE_CONTEXT_CHARS) {
    return SKIP_NOTICE;
  }

  const perSegmentBudget = Math.max(
    MIN_SEGMENT_CHARS,
    Math.floor(availableLength / segments.length) - 24,
  );

  const blocks = segments.map((segment, index) => {
    const trimmedContent = trimArtifactContext(segment.content, perSegmentBudget);

    if (segment.heading) {
      return `${segment.heading}\n${trimmedContent}`;
    }

    return `## 段落 ${index + 1}\n${trimmedContent}`;
  });

  const compressed = `${intro}${blocks.join("\n\n")}`.trim();
  return compressed.length <= maxLength ? compressed : trimArtifactContext(compressed, maxLength);
}

export function buildProjectContext(artifacts: ArtifactWithRevision[], draftOverlays: DraftOverlay[] = []) {
  const draftOverlayMap = new Map(
    draftOverlays
      .filter((overlay) => overlay.artifactId && overlay.outputContent.trim())
      .map((overlay) => [overlay.artifactId, overlay.outputContent.trim()]),
  );
  let remainingBudget = MAX_ARTIFACT_CONTEXT_CHARS_TOTAL;

  return artifacts
    .map((artifact) => {
      const draftOverlay = draftOverlayMap.get(artifact.id);
      const rawBody = draftOverlay ?? artifact.currentRevision?.content?.trim() ?? "_Empty artifact_";
      const artifactBudget = Math.min(MAX_ARTIFACT_CONTEXT_CHARS_PER_FILE, remainingBudget);
      const budgetedBody = artifactBudget > 0 ? buildCompressedArtifactContext(rawBody, artifactBudget) : SKIP_NOTICE;

      remainingBudget = Math.max(remainingBudget - budgetedBody.length, 0);

      const draftHeader = draftOverlay ? "\n> 使用当前 editor_autosave 草稿作为正文上下文" : "";
      return `# ${artifact.filename}${draftHeader}\n${budgetedBody}`;
    })
    .join("\n\n");
}

export function buildSelectedReferences(references: ReferenceDocument[]) {
  if (!references.length) {
    return "无";
  }

  return references
    .map((reference) => `# ${reference.filename}\n${reference.normalizedText ?? reference.extractedText ?? ""}`.trim())
    .join("\n\n");
}
