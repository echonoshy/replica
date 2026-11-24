export const CONTENT_PAGE_PATH = /^(?:(?:entities|topics)\/[a-z0-9][a-z0-9_-]{0,71}|timeline|conflicts)\.md$/;
export const isWikiPagePath = (path: string) => path === "_index.md" || CONTENT_PAGE_PATH.test(path);
export const anchorPattern = /(?<!\\)\[src:(doc_[a-zA-Z0-9_-]{1,80})#([pst][1-9][0-9]*)\]/g;

export const INDEX_MAX_LINES = 200;
export const INDEX_MAX_BYTES = 25_600;
export const UPLOAD_MAX_ITEMS = 20;
export const UPLOAD_FILE_BYTES = 20 * 1024 * 1024;
export const UPLOAD_BATCH_BYTES = 48 * 1024 * 1024;
export const extensions = ["md", "txt", "json", "docx", "pdf"] as const;
export type DocumentExtension = (typeof extensions)[number];

export function findAnchors(markdown: string) {
  return [...markdown.matchAll(anchorPattern)].map(([, docId, locator]) => ({
    docId,
    locator,
    anchor: `${docId}#${locator}`,
  }));
}
