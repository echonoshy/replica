import { lazy, Suspense } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import remarkGfm from "remark-gfm";
import type { Link, Nodes, PhrasingContent, Root } from "mdast";
import { anchorPattern, isWikiPagePath } from "@wiki-memory/shared/wiki-format";

const SOURCE_PREFIX = "#zhiwei-src=";
const CHAT_SOURCE_PREFIX = "#zhiwei-chat=";
const citationPattern = new RegExp(`${anchorPattern.source}|(?<!\\\\)\\[chat:([a-zA-Z0-9_-]{1,80})#(t[1-9][0-9]*)\\]`, "g");
const ReactMarkdown = lazy(() => import("react-markdown"));

export function headingId(name: string) {
  return name.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/\s+/g, "-");
}

function formatAnchorLabel(docId: string, locator: string, docLabelMap?: Record<string, string>) {
  const friendly = docLabelMap?.[docId];
  const locText = locator.startsWith("t")
    ? `#${locator}`
    : locator.startsWith("p")
      ? `第${locator.slice(1)}页`
      : `段落#${locator.slice(1)}`;
  if (friendly) return `${friendly} · ${locText}`;
  return `${docId.slice(0, 9)}… · ${locText}`;
}

function createRemarkSourcePlugin(docLabelMap?: Record<string, string>, sessionLabelMap?: Record<string, string>) {
  return function remarkSourceLinks() {
    const replace = (node: Nodes) => {
      if (!("children" in node) || node.type === "link" || node.type === "linkReference") return;
      const children = node.children as Nodes[];
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.type !== "text") {
          replace(child);
          continue;
        }
        const matches = [...child.value.matchAll(citationPattern)];
        if (!matches.length) continue;
        const parts: PhrasingContent[] = [];
        let offset = 0;
        for (const match of matches) {
          const start = match.index!;
          const [, docId, docLocator, sessionId, turnLocator] = match;
          const prefix = docId ? SOURCE_PREFIX : CHAT_SOURCE_PREFIX;
          const anchor = docId ? `${docId}#${docLocator}` : `${sessionId}#${turnLocator}`;
          const sessionTitle = sessionLabelMap?.[sessionId] ?? "历史对话";
          const shortTitle = sessionTitle.length > 12 ? `${sessionTitle.slice(0, 11)}…` : sessionTitle;
          const label = docId
            ? formatAnchorLabel(docId, docLocator, docLabelMap)
            : `原文 · ${shortTitle} #${turnLocator}`;
          if (start > offset) parts.push({ type: "text", value: child.value.slice(offset, start) });
          const link: Link = {
            type: "link",
            url: `${prefix}${encodeURIComponent(anchor)}`,
            children: [{ type: "text", value: label }],
          };
          parts.push(link);
          offset = start + match[0].length;
        }
        if (offset < child.value.length) parts.push({ type: "text", value: child.value.slice(offset) });
        children.splice(i, 1, ...parts);
        i += parts.length - 1;
      }
    };
    return (tree: Root) => replace(tree);
  };
}

function childText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(childText).join("");
  if (value && typeof value === "object" && "props" in value) {
    return childText((value.props as { children?: ReactNode }).children);
  }
  return "";
}

export function RichMarkdown({
  markdown,
  currentPath,
  docLabelMap,
  sessionLabelMap,
  onNavigate,
  onSource,
  onChatSource,
  className = "",
}: {
  markdown: string;
  currentPath?: string;
  docLabelMap?: Record<string, string>;
  sessionLabelMap?: Record<string, string>;
  onNavigate?: (path: string, fragment?: string) => void;
  onSource: (anchor: string) => void;
  onChatSource?: (sessionId: string, locator: string) => void;
  className?: string;
}) {
  const heading = (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") =>
    ({ children, ...props }: HTMLAttributes<HTMLHeadingElement>) => {
      const { node: _node, ...rest } = props as typeof props & { node?: unknown };
      return (
        <Tag {...rest} id={currentPath ? headingId(childText(children)) : undefined}>
          {children}
        </Tag>
      );
    };

  return (
    <div className={`editorial-prose ${className}`}>
      <Suspense fallback={null}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, createRemarkSourcePlugin(docLabelMap, sessionLabelMap)]}
        skipHtml
        components={{
          h1: heading("h1"),
          h2: heading("h2"),
          h3: heading("h3"),
          h4: heading("h4"),
          h5: heading("h5"),
          h6: heading("h6"),
          a: ({ href, children }) => {
            if (!href) return <span>{children}</span>;
            if (href.startsWith(CHAT_SOURCE_PREFIX)) {
              const match = /^([a-zA-Z0-9_-]{1,80})%23(t[1-9][0-9]*)$/.exec(href.slice(CHAT_SOURCE_PREFIX.length));
              if (!match || !onChatSource) return <span>{children}</span>;
              const [, sessionId, locator] = match;
              return (
                <button
                  type="button"
                  className="source-pill source-pill-chat"
                  onClick={() => onChatSource(sessionId, locator)}
                  title={`${sessionLabelMap?.[sessionId] ?? "历史对话"} · #${locator}`}
                >
                  <span aria-hidden="true">↗</span>
                  {children}
                </button>
              );
            }
            if (href.startsWith(SOURCE_PREFIX)) {
              const encoded = href.slice(SOURCE_PREFIX.length);
              if (!/^doc_[a-zA-Z0-9_-]{1,80}%23[pst][1-9][0-9]*$/.test(encoded)) {
                return <span>{children}</span>;
              }
              const anchor = decodeURIComponent(encoded);
              return (
                <button
                  type="button"
                  className="source-pill"
                  onClick={() => onSource(anchor)}
                  title={`点击溯源原始出处 [src:${anchor}]`}
                >
                  <span aria-hidden="true">↗</span>
                  {children}
                </button>
              );
            }
            if (currentPath && onNavigate) {
              try {
                const target = new URL(href, `https://wiki.local/${currentPath}`);
                const nextPath = decodeURIComponent(target.pathname.slice(1));
                if (target.origin === "https://wiki.local" && isWikiPagePath(nextPath)) {
                  const fragment = target.hash ? decodeURIComponent(target.hash.slice(1)) : undefined;
                  return (
                    <a
                      href={href}
                      onClick={(event) => {
                        event.preventDefault();
                        onNavigate(nextPath, fragment);
                      }}
                    >
                      {children}
                    </a>
                  );
                }
              } catch {
                return <span>{children}</span>;
              }
            }
            return /^https?:\/\//i.test(href) ? (
              <a href={href} target="_blank" rel="noreferrer">{children}</a>
            ) : (
              <span>{children}</span>
            );
          },
          table: ({ children }) => <div className="overflow-x-auto"><table>{children}</table></div>,
          img: () => null,
        }}
      >
        {markdown}
      </ReactMarkdown>
      </Suspense>
    </div>
  );
}
