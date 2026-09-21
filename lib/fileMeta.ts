import path from "path";
import { classify } from "@/lib/gemini";

export type SchemaFileType = "pdf" | "image" | "doc" | "text" | "other";

export function fileTypeForSchema(originalName: string): SchemaFileType {
  const cls = classify(originalName);
  if (cls === "office") return "doc";
  return cls;
}

export function pathTokens(originalPath: string): string[] {
  return path
    .dirname(originalPath)
    .split(/[\\/]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0 && t !== ".");
}
