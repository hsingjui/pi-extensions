import {
  createReadToolDefinition as createBaseReadToolDefinition,
  formatSize,
  truncateHead,
  type ReadToolDetails,
  type ReadToolInput,
} from "@mariozechner/pi-coding-agent";
import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import { formatDimensionNote, resizeImage } from "./image-resize.js";
import { detectSupportedImageMimeTypeFromFile } from "./mime.js";
import { resolveReadPath } from "./path-utils.js";

const READ_MAX_LINES = 200;
const READ_MAX_BYTES = 5 * 1024;

interface ReadOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  access: (absolutePath: string) => Promise<void>;
  detectImageMimeType?: (
    absolutePath: string,
  ) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
  readFile: (path) => fsReadFile(path),
  access: (path) => fsAccess(path, constants.R_OK),
  detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

type ToolTextContent = { type: "text"; text: string };
type ToolImageContent = { type: "image"; data: string; mimeType: string };
type ToolContent = ToolTextContent | ToolImageContent;

type ModelLike = {
  input?: string[];
};

type ReadToolContextLike = {
  model?: ModelLike;
};

function getDescription() {
  return `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${READ_MAX_LINES} lines or ${READ_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`;
}

function getNonVisionImageNote(
  model: ModelLike | undefined,
): string | undefined {
  if (!model || model.input?.includes("image")) {
    return undefined;
  }
  return "[Current model does not support images. The image will be omitted from this request.]";
}

export function createReadToolDefinition(cwd: string) {
  const base = createBaseReadToolDefinition(cwd);
  const ops = defaultReadOperations;

  return {
    ...base,
    description: getDescription(),
    async execute(
      _toolCallId: string,
      { path, offset, limit }: ReadToolInput,
      signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: ReadToolContextLike,
    ) {
      const absolutePath = resolveReadPath(path, cwd);
      return new Promise<{
        content: ToolContent[];
        details: ReadToolDetails | undefined;
      }>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Operation aborted"));
          return;
        }

        let aborted = false;
        const onAbort = () => {
          aborted = true;
          reject(new Error("Operation aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        (async () => {
          try {
            await ops.access(absolutePath);
            if (aborted) return;

            const mimeType = ops.detectImageMimeType
              ? await ops.detectImageMimeType(absolutePath)
              : undefined;
            let content: ToolContent[];
            let details: ReadToolDetails | undefined;

            if (mimeType) {
              const buffer = await ops.readFile(absolutePath);
              const base64 = buffer.toString("base64");
              const nonVisionImageNote = getNonVisionImageNote(ctx?.model);

              const resized = await resizeImage({
                type: "image",
                data: base64,
                mimeType,
              });
              if (!resized) {
                let textNote = `Read image file [${mimeType}]\n[Image omitted: could not be resized below the inline image size limit.]`;
                if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
                content = [{ type: "text", text: textNote }];
              } else {
                const dimensionNote = formatDimensionNote(resized);
                let textNote = `Read image file [${resized.mimeType}]`;
                if (dimensionNote) textNote += `\n${dimensionNote}`;
                if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
                content = [
                  { type: "text", text: textNote },
                  {
                    type: "image",
                    data: resized.data,
                    mimeType: resized.mimeType,
                  },
                ];
              }
            } else {
              const buffer = await ops.readFile(absolutePath);
              const textContent = buffer.toString("utf-8");
              const allLines = textContent.split("\n");
              const totalFileLines = allLines.length;
              const startLine = offset ? Math.max(0, offset - 1) : 0;
              const startLineDisplay = startLine + 1;

              if (startLine >= allLines.length) {
                throw new Error(
                  `Offset ${offset} is beyond end of file (${allLines.length} lines total)`,
                );
              }

              let selectedContent: string;
              let userLimitedLines: number | undefined;
              if (limit !== undefined) {
                const endLine = Math.min(startLine + limit, allLines.length);
                selectedContent = allLines.slice(startLine, endLine).join("\n");
                userLimitedLines = endLine - startLine;
              } else {
                selectedContent = allLines.slice(startLine).join("\n");
              }

              const truncation = truncateHead(selectedContent, {
                maxLines: READ_MAX_LINES,
                maxBytes: READ_MAX_BYTES,
              });
              let outputText: string;

              if (truncation.firstLineExceedsLimit) {
                const firstLineSize = formatSize(
                  Buffer.byteLength(allLines[startLine], "utf-8"),
                );
                outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(READ_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${READ_MAX_BYTES}]`;
                details = { truncation };
              } else if (truncation.truncated) {
                const endLineDisplay =
                  startLineDisplay + truncation.outputLines - 1;
                const nextOffset = endLineDisplay + 1;
                outputText = truncation.content;
                if (truncation.truncatedBy === "lines") {
                  outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
                } else {
                  outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(READ_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
                }
                details = { truncation };
              } else if (
                userLimitedLines !== undefined &&
                startLine + userLimitedLines < allLines.length
              ) {
                const remaining =
                  allLines.length - (startLine + userLimitedLines);
                const nextOffset = startLine + userLimitedLines + 1;
                outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
              } else {
                outputText = truncation.content;
              }

              content = [{ type: "text", text: outputText }];
            }

            if (aborted) return;
            signal?.removeEventListener("abort", onAbort);
            resolve({ content, details });
          } catch (error) {
            signal?.removeEventListener("abort", onAbort);
            if (!aborted) reject(error);
          }
        })();
      });
    },
  };
}
