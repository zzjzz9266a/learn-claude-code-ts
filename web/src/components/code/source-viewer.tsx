"use client";

import { useMemo } from "react";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeHighlight from "rehype-highlight";
import rehypeStringify from "rehype-stringify";

interface SourceViewerProps {
  source: string;
  filename: string;
}

export function inferCodeLanguage(filename: string): string {
  if (filename.endsWith(".tsx")) return "tsx";
  if (filename.endsWith(".ts")) return "typescript";
  if (filename.endsWith(".json")) return "json";
  if (filename.endsWith(".md")) return "markdown";
  if (filename.endsWith(".sh")) return "bash";
  return "typescript";
}

function extractCodeInnerHtml(html: string): string {
  const match = html.match(/<pre><code class="hljs(?: language-[^"]+)?">([\s\S]*?)<\/code><\/pre>/);
  return match?.[1] ?? html;
}

export function highlightSourceToHtml(source: string, filename: string): string {
  const language = inferCodeLanguage(filename);
  const markdown = `\`\`\`${language}\n${source}\n\`\`\``;
  const result = unified()
    .use(remarkParse)
    .use(remarkRehype)
    .use(rehypeHighlight, { detect: false, ignoreMissing: true })
    .use(rehypeStringify)
    .processSync(markdown);

  return extractCodeInnerHtml(String(result));
}

export function SourceViewer({ source, filename }: SourceViewerProps) {
  const highlightedLines = useMemo(() => {
    const html = highlightSourceToHtml(source, filename);
    return html.split("\n");
  }, [source, filename]);

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-700">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-700">
        <div className="flex gap-1.5">
          <span className="h-3 w-3 rounded-full bg-red-400" />
          <span className="h-3 w-3 rounded-full bg-yellow-400" />
          <span className="h-3 w-3 rounded-full bg-green-400" />
        </div>
        <span className="font-mono text-xs text-zinc-400">{filename}</span>
      </div>
      <div className="overflow-x-auto bg-zinc-950">
        <pre className="p-2 text-[10px] leading-4 sm:p-4 sm:text-xs sm:leading-5">
          <code>
            {highlightedLines.map((line, i) => (
              <div key={i} className="flex">
                <span className="mr-2 inline-block w-6 shrink-0 select-none text-right text-zinc-600 sm:mr-4 sm:w-8">
                  {i + 1}
                </span>
                <span
                  className="text-zinc-200 [&_.hljs-keyword]:text-blue-400 [&_.hljs-keyword]:font-medium [&_.hljs-string]:text-emerald-500 [&_.hljs-number]:text-orange-400 [&_.hljs-comment]:text-zinc-400 [&_.hljs-comment]:italic [&_.hljs-title]:text-cyan-300 [&_.hljs-function_.hljs-title]:text-cyan-300 [&_.hljs-params]:text-zinc-300 [&_.hljs-built_in]:text-violet-300 [&_.hljs-literal]:text-amber-300 [&_.hljs-type]:text-teal-300 [&_.hljs-property]:text-zinc-200"
                  dangerouslySetInnerHTML={{ __html: line || "&nbsp;" }}
                />
              </div>
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
}
