export const MAX_ATTACHMENT_COUNT = 3;
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
export const MAX_VIDEO_SIZE = 100 * 1024 * 1024;
export const MAX_TOTAL_SIZE = 200 * 1024 * 1024;

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif"]);
const VIDEO_TYPES = new Set(["video/x-matroska", "video/mp4"]);
const EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "mkv", "mp4"]);

export function validateIssueAttachments(files: File[]): string | null {
  if (files.length > MAX_ATTACHMENT_COUNT) {
    return `最多上传 ${MAX_ATTACHMENT_COUNT} 个附件`;
  }

  let totalSize = 0;
  for (const file of files) {
    const extension = file.name.split(".").pop()?.toLowerCase() || "";
    if (!EXTENSIONS.has(extension) || (!IMAGE_TYPES.has(file.type) && !VIDEO_TYPES.has(file.type))) {
      return `${file.name} 的文件类型不支持`;
    }
    if (IMAGE_TYPES.has(file.type) && file.size > MAX_IMAGE_SIZE) {
      return `${file.name} 超过图片 10 MB 限制`;
    }
    if (VIDEO_TYPES.has(file.type) && file.size > MAX_VIDEO_SIZE) {
      return `${file.name} 超过视频 100 MB 限制`;
    }
    totalSize += file.size;
  }

  if (totalSize > MAX_TOTAL_SIZE) {
    return "附件总大小不能超过 200 MB";
  }
  return null;
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
