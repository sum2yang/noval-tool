import { describe, expect, it } from "vitest";

import { parseUploadedReferenceSummaries } from "./upload-response";

describe("parseUploadedReferenceSummaries", () => {
  it("reads the multipart batch upload response", () => {
    expect(
      parseUploadedReferenceSummaries({
        count: 2,
        filenames: ["notes.txt", "outline.md"],
        items: [
          { id: "ref-1", filename: "notes.txt" },
          { id: "ref-2", filename: "outline.md" },
        ],
      }),
    ).toEqual([
      { id: "ref-1", filename: "notes.txt" },
      { id: "ref-2", filename: "outline.md" },
    ]);
  });

  it("keeps compatibility with the legacy single-item response", () => {
    expect(parseUploadedReferenceSummaries({ id: "ref-1", filename: "notes.txt" })).toEqual([
      { id: "ref-1", filename: "notes.txt" },
    ]);
  });

  it("throws on malformed payloads", () => {
    expect(() => parseUploadedReferenceSummaries({ count: 1, filenames: ["notes.txt"], items: [{}] })).toThrowError(
      "资料上传返回格式异常。",
    );
  });
});
