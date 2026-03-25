export type UploadedReferenceSummary = {
  id: string;
  filename: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUploadedReferenceSummary(value: unknown): value is UploadedReferenceSummary {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.filename === "string" &&
    value.filename.trim().length > 0
  );
}

export function parseUploadedReferenceSummaries(payload: unknown): UploadedReferenceSummary[] {
  if (isRecord(payload) && Array.isArray(payload.items)) {
    const items = payload.items.filter(isUploadedReferenceSummary);

    if (items.length > 0) {
      return items;
    }
  }

  if (isUploadedReferenceSummary(payload)) {
    return [payload];
  }

  throw new Error("资料上传返回格式异常。");
}
