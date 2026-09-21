"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

interface SearchResult {
  pool_name: string;
  original_name: string;
  original_path: string;
  summary: string;
  file_type: string;
  score: number;
  matched_on: string[];
}

const ORG_NAME = process.env.NEXT_PUBLIC_ORG_NAME || "";
const PAGE_TITLE = ORG_NAME ? `${ORG_NAME} File Search` : "File Search";

type SearchMode = "name" | "keyword" | "content";

const SEARCH_MODES: { value: SearchMode; label: string; hint: string }[] = [
  { value: "name", label: "Name", hint: "Instant — matches file names" },
  { value: "keyword", label: "Keyword", hint: "Fast — matches extracted keywords" },
  { value: "content", label: "Smart (AI)", hint: "Slower — understands vague descriptions" },
];

export default function Home() {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("name");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback(async (q: string, searchMode: SearchMode) => {
    if (!q.trim()) {
      setResults(null);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&mode=${searchMode}`);
      const data = await res.json();
      setResults(data);
    } finally {
      setLoading(false);
    }
  }, []);

  const onQueryChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(value, mode), 300);
  };

  const onModeChange = (value: SearchMode) => {
    setMode(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim()) runSearch(query, value);
  };

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      runSearch(query, mode);
    }
  };

  const copyPath = async (path: string) => {
    await navigator.clipboard.writeText(path);
    setCopiedPath(path);
    setTimeout(() => setCopiedPath(null), 1500);
  };

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div className="flex flex-col flex-1 items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-3xl flex-col gap-6 px-6 py-12">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{PAGE_TITLE}</h1>
          <div className="flex shrink-0 gap-2">
            <Link
              href="/sync-files"
              className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Sync New Files
            </Link>
            <Link
              href="/sync-summaries"
              className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Sync Summaries
            </Link>
          </div>
        </div>

        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onEnter}
          placeholder="Search..."
          className="w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 text-base text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
        />

        <div className="flex flex-wrap gap-2">
          {SEARCH_MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => onModeChange(m.value)}
              title={m.hint}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                mode === m.value
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          {loading && <p className="text-sm text-zinc-500">Searching...</p>}

          {!loading && results !== null && results.length === 0 && (
            <p className="text-sm text-zinc-500">No results found.</p>
          )}

          {!loading && results === null && (
            <p className="text-sm text-zinc-500">Type to search files in the pool.</p>
          )}

          {!loading &&
            results?.map((r) => (
              <div
                key={r.pool_name}
                className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div className="flex items-start justify-between gap-3">
                  <a
                    href={`/api/file?name=${encodeURIComponent(r.pool_name)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-zinc-900 hover:underline dark:text-zinc-50"
                  >
                    {r.original_name}
                  </a>
                  <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                    {r.file_type}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <code className="truncate text-xs text-zinc-500 dark:text-zinc-400">{r.original_path}</code>
                  <button
                    onClick={() => copyPath(r.original_path)}
                    className="shrink-0 text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                  >
                    {copiedPath === r.original_path ? "Copied!" : "Copy path"}
                  </button>
                </div>

                <p className="line-clamp-2 text-sm text-zinc-600 dark:text-zinc-400">{r.summary}</p>

                <div className="flex items-center gap-3">
                  {(r.file_type === "doc") && (
                    <a
                      href={`/api/file?name=${encodeURIComponent(r.pool_name)}&download=1`}
                      className="text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                    >
                      Download original
                    </a>
                  )}
                </div>

                <div className="flex gap-1">
                  {r.matched_on.map((m) => (
                    <span
                      key={m}
                      className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                    >
                      {m} match
                    </span>
                  ))}
                </div>
              </div>
            ))}
        </div>
      </main>
    </div>
  );
}
