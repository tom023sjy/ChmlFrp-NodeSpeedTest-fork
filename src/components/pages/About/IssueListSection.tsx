/**
 * 我的工单 - 工单列表与详情
 *
 * 展示当前用户提交的工单列表，点击查看详情（含管理员与用户回复）。
 * 用户可在详情中回复工单（closed 状态除外），工单与回复附件支持在线预览。
 */
import { useState, useEffect, useCallback, useRef } from "react";
import {
  listIssues,
  getIssueDetail,
  replyIssue,
  getCurrentUser,
  type IssueListItem,
  type IssueDetail,
  type IssueAttachment,
} from "@/services/backendApi";
import { resolveIssueAttachmentUrl } from "@/services/issueAttachmentCache";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  RefreshCw,
  MessageSquare,
  Clock,
  CheckCircle2,
  AlertCircle,
  ChevronRight,
  Send,
  User as UserIcon,
  Headset,
 Mail,
  Phone,
  Paperclip,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  formatAttachmentSize,
  MAX_ATTACHMENT_COUNT,
  validateIssueAttachments,
} from "./issueAttachments";

/** 附件画廊：图片缩略图（点击放大）+ 视频在线播放 */
function AttachmentGallery({
  attachments,
  previewUrls,
  onImageClick,
}: {
  attachments: IssueAttachment[];
  previewUrls: Record<number, string>;
  onImageClick: (attachment: IssueAttachment) => void;
}) {
  if (!attachments.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((attachment) => {
        const url = previewUrls[attachment.id];
        if (attachment.mimeType.startsWith("image/")) {
          return (
            <button
              key={attachment.id}
              type="button"
              title={attachment.name}
              onClick={() => onImageClick(attachment)}
              className="rounded-lg overflow-hidden border border-border/60 bg-muted/30 hover:border-primary/50 transition-colors cursor-pointer"
            >
              {url ? (
                <img
                  src={url}
                  alt={attachment.name}
                  loading="lazy"
                  className="max-h-32 max-w-[220px] object-contain"
                />
              ) : (
                <div className="h-20 w-28 animate-pulse bg-muted" />
              )}
            </button>
          );
        }
        return url ? (
          <video
            key={attachment.id}
            src={url}
            controls
            preload="metadata"
            className="max-h-48 max-w-full rounded-lg border border-border/60"
          />
        ) : (
          <div key={attachment.id} className="h-24 w-40 animate-pulse rounded-lg bg-muted/40" />
        );
      })}
    </div>
  );
}

// 状态标签配置（与后端枚举一致：open / in_progress / resolved / closed）
const STATUS_CONFIG: Record<
  string,
  { label: string; className: string; icon: typeof Clock }
> = {
  open: {
    label: "待处理",
    className: "bg-amber-50 text-amber-700",
    icon: Clock,
  },
  in_progress: {
    label: "处理中",
    className: "bg-blue-50 text-blue-700",
    icon: AlertCircle,
  },
  resolved: {
    label: "已解决",
    className: "bg-emerald-50 text-emerald-700",
    icon: CheckCircle2,
  },
  closed: {
    label: "已关闭",
    className: "bg-muted text-muted-foreground",
    icon: CheckCircle2,
  },
};

// 兼容旧状态值（数据库迁移期间可能存在 pending/processing）
const STATUS_ALIAS: Record<string, string> = {
  pending: "open",
  processing: "in_progress",
};

function normalizeStatus(status: string): string {
  return STATUS_ALIAS[status] || status;
}

function getStatusConfig(status: string) {
  return STATUS_CONFIG[normalizeStatus(status)] || STATUS_CONFIG.open;
}

const CATEGORY_LABEL: Record<string, string> = {
  bug: "Bug",
  feature: "建议",
  other: "其他",
};

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return dateStr;
  }
}

export function IssueListSection() {
  const [issues, setIssues] = useState<IssueListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [replyContent, setReplyContent] = useState("");
  const [replying, setReplying] = useState(false);
  const replyScrollRef = useRef<HTMLDivElement>(null);
  // 附件预览 URL（含主附件与回复附件，key 为附件 id）
  const [previewUrls, setPreviewUrls] = useState<Record<number, string>>({});
  // 图片放大查看的预览地址
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  // 回复待上传附件
  const [replyFiles, setReplyFiles] = useState<File[]>([]);
  // 回复附件上传进度（0-100，null 表示不在上传）
  const [replyUploadProgress, setReplyUploadProgress] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 防止快速切换工单时预览 URL 串扰
  const detailIdRef = useRef<number | null>(null);

  const loadIssues = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listIssues({ page: 1, pageSize: 50 });
      if (res.success) {
        setIssues(res.data);
      }
    } catch {
      // 静默失败
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadIssues();
  }, [loadIssues]);

  /** 加载详情并批量获取附件预览 URL */
  const refreshDetail = useCallback(async (id: number, reset: boolean) => {
    if (reset) {
      detailIdRef.current = id;
      setDetail(null);
      setPreviewUrls({});
      setLoadingDetail(true);
    }
    try {
      const res = await getIssueDetail(id);
      if (detailIdRef.current !== id) return;
      if (res.success) {
        setDetail(res.data);
        // 收集全部附件（主附件 + 回复附件），并行获取签名预览 URL（10 分钟有效）
        const all = [
          ...(res.data.attachments || []),
          ...(res.data.replies || []).flatMap((r) => r.attachments || []),
        ];
        const entries = await Promise.all(
          all.map(async (attachment) => {
            try {
              const url = await resolveIssueAttachmentUrl(id, attachment, (cachedUrl) => {
                if (detailIdRef.current !== id) return;
                setPreviewUrls((prev) => ({ ...prev, [attachment.id]: cachedUrl }));
              });
              return [attachment.id, url] as const;
            } catch {
              return [attachment.id, ""] as const;
            }
          }),
        );
        if (detailIdRef.current !== id) return;
        setPreviewUrls(Object.fromEntries(entries));
      }
    } catch {
      // 静默失败
    } finally {
      if (detailIdRef.current === id) setLoadingDetail(false);
    }
  }, []);

  const handleViewDetail = (id: number) => {
    setDetailOpen(true);
    setReplyContent("");
    setReplyFiles([]);
    refreshDetail(id, true);
  };

  const openImagePreview = (url: string) => {
    if (!url) return;
    setDetailOpen(false);
    setLightboxUrl(url);
  };

  const closeImagePreview = () => {
    setLightboxUrl(null);
    setDetailOpen(true);
  };

  useEffect(() => {
    if (!lightboxUrl) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeImagePreview();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [lightboxUrl]);

  const handleReplyFileSelect = (files: FileList | null) => {
    if (!files || !files.length) return;
    const merged = [...replyFiles, ...Array.from(files)];
    const error = validateIssueAttachments(merged);
    if (error) {
      toast.warning(error);
      return;
    }
    setReplyFiles(merged);
  };

  const removeReplyFile = (index: number) => {
    setReplyFiles((prev) => prev.filter((_, i) => i !== index));
  };

  // 判断回复者是否为当前用户（用户回复）
  const isUserReply = (repliedBy?: string | null): boolean => {
    if (!repliedBy) return false;
    const me = getCurrentUser();
    return !!me && me.username === repliedBy;
  };

  const handleReply = async () => {
    if (!detail) return;
    const content = replyContent.trim();
    if (!content) {
      toast.warning("请输入回复内容");
      return;
    }
    if (content.length > 2000) {
      toast.warning("回复内容不能超过 2000 字");
      return;
    }

    setReplying(true);
    // 仅带附件时跟踪上传进度（无附件走 JSON，无上传阶段）
    const hasFiles = replyFiles.length > 0;
    if (hasFiles) setReplyUploadProgress(0);
    try {
      await replyIssue(
        detail.id,
        content,
        replyFiles,
        hasFiles ? setReplyUploadProgress : undefined,
      );
      toast.success("回复成功");
      setReplyContent("");
      setReplyFiles([]);
      // 刷新详情（含新回复附件的预览 URL），并同步列表状态
      const res = await getIssueDetail(detail.id);
      if (res.success) {
        setDetail(res.data);
        // 新回复附件需要补取预览 URL
        const newAttachments = (res.data.replies || []).flatMap(
          (r) => r.attachments || [],
        );
        const entries = await Promise.all(
          newAttachments.map(async (attachment) => {
            try {
              const url = await resolveIssueAttachmentUrl(
                detail.id,
                attachment,
                (cachedUrl) => {
                  setPreviewUrls((prev) => ({ ...prev, [attachment.id]: cachedUrl }));
                },
              );
              return [attachment.id, url] as const;
            } catch {
              return [attachment.id, ""] as const;
            }
          }),
        );
        setPreviewUrls((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
        // 同步刷新列表中的状态/时间
        setIssues((prev) =>
          prev.map((it) =>
            it.id === detail.id
              ? {
                  ...it,
                  status: res.data.status,
                  updated_at: res.data.updated_at,
                }
              : it,
          ),
        );
        // 滚动到最新回复
        setTimeout(() => {
          replyScrollRef.current?.scrollTo({
            top: replyScrollRef.current.scrollHeight,
            behavior: "smooth",
          });
        }, 100);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "回复失败");
    } finally {
      setReplying(false);
      setReplyUploadProgress(null);
    }
  };

  if (loading && issues.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
        加载中...
      </div>
    );
  }

  if (issues.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center">
        <MessageSquare className="w-10 h-10 text-muted-foreground/40 mb-3" />
        <p className="text-sm text-muted-foreground">暂无工单记录</p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          提交的工单会显示在这里
        </p>
      </div>
    );
  }

  const isClosed = detail ? normalizeStatus(detail.status) === "closed" : false;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-foreground">我的工单</h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={loadIssues}
          disabled={loading}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          刷新
        </Button>
      </div>

      <div className="space-y-2">
        {issues.map((issue) => {
          const statusCfg = getStatusConfig(issue.status);
          const StatusIcon = statusCfg.icon;
          return (
            <button
              key={issue.id}
              onClick={() => handleViewDetail(issue.id)}
              className="w-full text-left rounded-xl border border-border/60 bg-card p-3 hover:border-primary/40 hover:bg-muted/30 transition-colors cursor-pointer group"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">
                    {issue.title}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                    {issue.description}
                  </p>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium ${statusCfg.className}`}
                  >
                    <StatusIcon className="w-3 h-3" />
                    {statusCfg.label}
                  </span>
                  <ChevronRight className="w-4 h-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </div>
              </div>
              <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground">
                <span>{CATEGORY_LABEL[issue.category] || "其他"}</span>
                <span>·</span>
                <span>{formatDate(issue.created_at)}</span>
                {issue.app_version && (
                  <>
                    <span>·</span>
                    <span>v{issue.app_version}</span>
                  </>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* 工单详情对话框 */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="z-[10000] max-w-[560px]">
          <DialogHeader>
            <DialogTitle>工单详情</DialogTitle>
          </DialogHeader>
          {loadingDetail ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
              加载中...
            </div>
          ) : detail ? (
            <div className="space-y-4 py-2">
              {/* 标题与元信息 */}
              <div>
                <h3 className="text-base font-semibold text-foreground">
                  {detail.title}
                </h3>
                <div className="flex items-center gap-2 mt-2">
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium ${getStatusConfig(detail.status).className}`}
                  >
                    {getStatusConfig(detail.status).label}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {CATEGORY_LABEL[detail.category] || "其他"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(detail.created_at)}
                  </span>
                </div>
              </div>

              {/* 问题描述 */}
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1.5">
                  问题描述
                </p>
                <p className="text-sm text-foreground whitespace-pre-wrap bg-muted/30 rounded-lg p-3">
                  {detail.description}
                </p>
                {/* 工单主附件画廊 */}
                {detail.attachments && detail.attachments.length > 0 && (
                  <div className="mt-2">
                    <AttachmentGallery
                      attachments={detail.attachments}
                      previewUrls={previewUrls}
                      onImageClick={(attachment) =>
                        openImagePreview(previewUrls[attachment.id] || "")
                      }
                    />
                  </div>
                )}
              </div>

              {/* 联系方式（用户提交时填写，可能为空表示匿名） */}
              {(detail.contact_email || detail.contact_phone) && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1.5">
                    联系方式
                  </p>
                  <div className="flex flex-wrap items-center gap-3 text-sm text-foreground">
                    {detail.contact_email && (
                      <span className="inline-flex items-center gap-1.5 bg-muted/30 rounded-lg px-2.5 py-1">
                        <Mail className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="break-all">{detail.contact_email}</span>
                      </span>
                    )}
                    {detail.contact_phone && (
                      <span className="inline-flex items-center gap-1.5 bg-muted/30 rounded-lg px-2.5 py-1">
                        <Phone className="w-3.5 h-3.5 text-muted-foreground" />
                        <span>{detail.contact_phone}</span>
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* 回复列表 */}
              {detail.replies && detail.replies.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1.5">
                    回复（{detail.replies.length}）
                  </p>
                  <div ref={replyScrollRef} className="space-y-2 max-h-[240px] overflow-y-auto pr-1">
                    {detail.replies.map((reply) => {
                      const isMine = isUserReply(reply.replied_by);
                      return (
                        <div
                          key={reply.id}
                          className={`rounded-lg p-3 ${
                            isMine
                              ? "bg-primary/5 border border-primary/10"
                              : "bg-blue-50/50 border border-blue-100"
                          }`}
                        >
                          <div className="flex items-center gap-1.5 mb-1.5">
                            {isMine ? (
                              <UserIcon className="w-3 h-3 text-primary" />
                            ) : (
                              <Headset className="w-3 h-3 text-blue-600" />
                            )}
                            <span
                              className={`text-[11px] font-medium ${
                                isMine ? "text-primary" : "text-blue-600"
                              }`}
                            >
                              {isMine ? "我" : "客服"}
                              {!isMine && reply.replied_by ? ` · ${reply.replied_by}` : ""}
                            </span>
                            <span className="text-[11px] text-muted-foreground ml-auto">
                              {formatDate(reply.created_at)}
                            </span>
                          </div>
                          <p className="text-sm text-foreground whitespace-pre-wrap">
                            {reply.content}
                          </p>
                          {reply.attachments && reply.attachments.length > 0 && (
                            <div className="mt-2">
                              <AttachmentGallery
                                attachments={reply.attachments}
                                previewUrls={previewUrls}
                                onImageClick={(attachment) =>
                                  openImagePreview(previewUrls[attachment.id] || "")
                                }
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 回复输入区（closed 工单不显示） */}
              {!isClosed && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1.5">
                    回复工单
                  </p>
                  <Textarea
                    value={replyContent}
                    onChange={(e) => setReplyContent(e.target.value)}
                    placeholder="请输入回复内容...（最多 2000 字）"
                    className="min-h-[80px] resize-y text-sm"
                    maxLength={2000}
                  />
                  {/* 回复附件选择 */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept=".jpg,.jpeg,.png,.gif,.mkv,.mp4"
                    className="hidden"
                    onChange={(e) => {
                      handleReplyFileSelect(e.target.files);
                      e.target.value = "";
                    }}
                  />
                  {replyFiles.length > 0 && (
                    <div className="mt-2">
                      <div className="flex flex-wrap gap-2">
                        {replyFiles.map((file, index) => {
                          // 单请求顺序上传，按文件大小占比拆分整体进度
                          const totalReplyBytes = replyFiles.reduce((sum, f) => sum + f.size, 0);
                          const share = totalReplyBytes > 0 ? file.size / totalReplyBytes : 0;
                          const filePercent = Math.min(
                            100,
                            Math.round((replyUploadProgress ?? 0) * share * 100) / 100,
                          );
                          const uploading = replying && replyUploadProgress !== null;
                          return (
                            <span
                              key={`${file.name}-${index}`}
                              className="inline-flex items-center gap-1.5 bg-muted/50 border border-border/60 rounded-lg px-2.5 py-1.5 text-xs text-foreground"
                            >
                              <Paperclip className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                              <span className="truncate max-w-[160px]" title={file.name}>
                                {file.name}
                              </span>
                              <span
                                className={`flex-shrink-0 tabular-nums ${
                                  uploading && filePercent >= 100
                                    ? "text-emerald-600 dark:text-emerald-400"
                                    : "text-muted-foreground"
                                }`}
                              >
                                {uploading
                                  ? filePercent >= 100
                                    ? "完成"
                                    : `${Math.round(filePercent)}%`
                                  : formatAttachmentSize(file.size)}
                              </span>
                              <button
                                type="button"
                                title="移除附件"
                                onClick={() => removeReplyFile(index)}
                                disabled={replying}
                                className="text-muted-foreground hover:text-red-500 transition-colors flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </span>
                          );
                        })}
                      </div>
                      {replying && replyUploadProgress !== null && (
                        <div className="mt-2">
                          <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1">
                            <span>回复附件上传中</span>
                            <span className="tabular-nums">
                              {Math.round(replyUploadProgress)}%
                            </span>
                          </div>
                          <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                            <div
                              className={`h-full rounded-full transition-all duration-200 ${
                                replyUploadProgress >= 100
                                  ? "bg-emerald-500"
                                  : "bg-blue-500"
                              }`}
                              style={{ width: `${Math.min(100, replyUploadProgress)}%` }}
                            />
                          </div>
                          {replyUploadProgress >= 100 && (
                            <p className="text-[11px] text-muted-foreground mt-1">
                              上传完成，等待服务器处理
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="flex items-center justify-between mt-2">
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={replying || replyFiles.length >= MAX_ATTACHMENT_COUNT}
                      >
                        <Paperclip className="w-3.5 h-3.5" />
                        附件（{replyFiles.length}/{MAX_ATTACHMENT_COUNT}）
                      </Button>
                      <span className="text-[11px] text-muted-foreground">
                        {replyContent.length}/2000
                      </span>
                    </div>
                    <Button
                      size="sm"
                      onClick={handleReply}
                      disabled={replying || !replyContent.trim()}
                    >
                      {replying ? (
                        <>
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          发送中...
                        </>
                      ) : (
                        <>
                          <Send className="w-3.5 h-3.5" />
                          发送
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              )}

              {isClosed && (
                <div className="text-center py-2 text-xs text-muted-foreground bg-muted/30 rounded-lg">
                  工单已关闭，无法回复
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">
              加载失败
            </p>
          )}
        </DialogContent>
      </Dialog>

      {/* 图片放大查看（置于详情对话框之上） */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/80 backdrop-blur-sm p-8 cursor-zoom-out"
          onClick={closeImagePreview}
        >
          <img
            src={lightboxUrl}
            alt="附件预览"
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
