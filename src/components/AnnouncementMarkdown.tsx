import { useEffect, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";

interface AnnouncementMarkdownProps {
  content: string;
}

function isSafeUrl(url: string | undefined): url is string {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textContent((node.props as { children?: ReactNode }).children);
  }
  return "";
}

function CopyableCodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);
  const code = textContent(children).replace(/\n$/, "");

  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="group relative my-3 overflow-hidden rounded-md border bg-zinc-950 text-zinc-100">
      <button
        type="button"
        className="absolute right-2 top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded border border-zinc-700 bg-zinc-900 text-zinc-300 opacity-80 transition hover:bg-zinc-800 hover:text-white hover:opacity-100"
        onClick={() => void handleCopy()}
        title={copied ? "已复制" : "复制代码"}
        aria-label={copied ? "已复制" : "复制代码"}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      <pre className="m-0 whitespace-pre-wrap break-words p-4 pr-12 font-mono text-xs leading-5 [overflow-wrap:anywhere]">
        {code}
      </pre>
    </div>
  );
}

export function AnnouncementMarkdown({ content }: AnnouncementMarkdownProps) {
  return (
    <ReactMarkdown
      components={{
        h1: ({ children }) => <h2 className="mb-3 mt-1 text-lg font-semibold">{children}</h2>,
        h2: ({ children }) => <h3 className="mb-2 mt-4 text-base font-semibold">{children}</h3>,
        h3: ({ children }) => <h4 className="mb-2 mt-3 text-sm font-semibold">{children}</h4>,
        p: ({ children }) => <p className="my-2 leading-6">{children}</p>,
        ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
        blockquote: ({ children }) => <blockquote className="my-3 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>,
        pre: ({ children }) => <CopyableCodeBlock>{children}</CopyableCodeBlock>,
        code: ({ children }) => <code className="whitespace-pre-wrap break-words rounded bg-muted px-1 py-0.5 font-mono text-xs [overflow-wrap:anywhere]">{children}</code>,
        hr: () => <hr className="my-4 border-border" />,
        img: () => null,
        a: ({ href, children }) => isSafeUrl(href) ? (
          <button
            type="button"
            className="inline break-all text-primary underline underline-offset-4 hover:text-primary/80"
            onClick={() => void openUrl(href)}
          >
            {children}
          </button>
        ) : <span>{children}</span>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
