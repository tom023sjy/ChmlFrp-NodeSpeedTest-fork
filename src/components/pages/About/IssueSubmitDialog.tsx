/**
 * 提交工单对话框
 *
 * 用户填写标题、描述、分类后，点击提交触发极验 GT4 验证码，
 * 验证通过后调用后端 /api/issues/submit 提交工单。
 */
import { useState, useEffect, useRef } from "react";
import { AlertCircle, FileImage, FileVideo, Paperclip, Trash2, Upload } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useGeetest } from "@/hooks/useGeetest";
import {
  submitIssue,
  getIssueSubmitPermission,
  isBackendAuthenticated,
  getCurrentUser,
  BackendApiError,
  type IssueCategory,
  type IssueSubmitPermission,
} from "@/services/backendApi";
import { toast } from "sonner";
import {
  formatAttachmentSize,
  MAX_ATTACHMENT_COUNT,
  validateIssueAttachments,
} from "./issueAttachments";

interface IssueSubmitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 提交成功后的回调 */
  onSuccess?: () => void;
}

const CATEGORY_OPTIONS = [
  { value: "bug", label: "Bug 报告" },
  { value: "feature", label: "功能建议" },
  { value: "other", label: "其他" },
];

export function IssueSubmitDialog({
  open,
  onOpenChange,
  onSuccess,
}: IssueSubmitDialogProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<string>("bug");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [captchaActive, setCaptchaActive] = useState(false);
  const [attachments, setAttachments] = useState<File[]>([]);
  /** 附件上传进度（0-100）；null 表示当前不在上传阶段 */
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [permission, setPermission] = useState<IssueSubmitPermission | null>(null);
  const [permissionLoading, setPermissionLoading] = useState(false);
  const [permissionUnavailable, setPermissionUnavailable] = useState(false);
  const previousOpenRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { ready: captchaReady, verify: verifyCaptcha } = useGeetest(open);

  useEffect(() => {
    const isNewSession = open && !previousOpenRef.current;
    previousOpenRef.current = open;
    if (isNewSession) {
      setTitle("");
      setDescription("");
      setCategory("bug");
      setSubmitting(false);
      setCaptchaActive(false);
      setAttachments([]);
      setUploadProgress(null);
      const me = getCurrentUser();
      setContactEmail(me?.email || "");
      setContactPhone(me?.phone || "");

      setPermissionLoading(true);
      setPermissionUnavailable(false);
      void getIssueSubmitPermission()
        .then(setPermission)
        .catch(() => {
          setPermission(null);
          setPermissionUnavailable(true);
        })
        .finally(() => setPermissionLoading(false));
    }
  }, [open]);

  const totalAttachmentBytes = attachments.reduce((sum, file) => sum + file.size, 0);

  const handleFiles = (files: File[]) => {
    const next = [...attachments, ...files];
    const error = validateIssueAttachments(next);
    if (error) {
      toast.error(error);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setAttachments(next);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeAttachment = (index: number) => {
    setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index));
  };

  const applyPermissionError = (error: BackendApiError) => {
    if (!["ISSUE_BANNED", "ISSUE_NEW_USER_COOLDOWN", "ISSUE_DAILY_LIMIT"].includes(error.code || "")) {
      return;
    }
    const details = error.details || {};
    setPermission({
      success: false,
      allowed: false,
      code: error.code as IssueSubmitPermission["code"],
      message: error.message,
      dailyLimit: Number(details.dailyLimit || 5),
      submittedToday: Number(details.submittedToday || 0),
      remainingToday: Number(details.remainingToday || 0),
      firstLoginAt: typeof details.firstLoginAt === "string" ? details.firstLoginAt : null,
      eligibleAt: typeof details.eligibleAt === "string" ? details.eligibleAt : null,
      bannedReason: typeof details.bannedReason === "string" ? details.bannedReason : null,
    });
  };

  const handleSubmit = async () => {
    // 登录态兜底校验（防止绕过 About 页面按钮禁用）
    if (!isBackendAuthenticated()) {
      toast.error("请先登录后再提交工单");
      return;
    }
    if (!title.trim()) {
      toast.error("请填写标题");
      return;
    }
    if (!description.trim()) {
      toast.error("请填写工单描述");
      return;
    }
    // 联系方式格式校验（选填，留空即匿名）
    const emailVal = contactEmail.trim();
    const phoneVal = contactPhone.trim();
    if (emailVal && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) {
      toast.error("邮箱格式不正确");
      return;
    }
    if (phoneVal && !/^[+]?[\d\s\-()]{6,20}$/.test(phoneVal)) {
      toast.error("手机号格式不正确");
      return;
    }
    if (!captchaReady) {
      toast.error("验证码正在加载，请稍候");
      return;
    }
    if (permission && !permission.allowed) {
      toast.error(permission.message);
      return;
    }

    setSubmitting(true);
    setCaptchaActive(true);
    try {
      const geetestResult = await verifyCaptcha();
      setCaptchaActive(false);
      if (!geetestResult) {
        toast.error("请完成验证码校验");
        return;
      }

      const res = await submitIssue(
        {
          title: title.trim(),
          description: description.trim(),
          category: category as IssueCategory,
          contactEmail: emailVal,
          contactPhone: phoneVal,
          attachments,
        },
        geetestResult,
        (percent) => setUploadProgress(percent),
      );

      if (res.success) {
        toast.success("工单已提交，我们会尽快处理");
        setAttachments([]);
        onOpenChange(false);
        onSuccess?.();
      } else {
        toast.error(res.message || "提交失败");
      }
    } catch (err) {
      setCaptchaActive(false);
      if (err instanceof BackendApiError) applyPermissionError(err);
      toast.error(err instanceof Error ? err.message : "提交失败");
    } finally {
      setSubmitting(false);
      setUploadProgress(null);
    }
  };

  return (
    <Dialog open={open && !captchaActive} onOpenChange={(next) => {
      if (!captchaActive) onOpenChange(next);
    }}>
      <DialogContent className="z-[10000] max-h-[85vh] max-w-[560px] overflow-y-auto visible-scrollbar">
        <DialogHeader>
          <DialogTitle>提交工单</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {permissionLoading ? (
            <div className="text-xs text-muted-foreground">正在检查提交资格...</div>
          ) : permission && !permission.allowed ? (
            <div className="flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <div>
                <p className="font-medium">暂时无法提交工单</p>
                <p className="mt-0.5 text-xs">{permission.bannedReason || permission.message}</p>
                {permission.eligibleAt && (
                  <p className="mt-1 text-xs">可提交时间：{new Date(permission.eligibleAt).toLocaleString()}</p>
                )}
              </div>
            </div>
          ) : permission?.allowed ? (
            <div className="text-xs text-muted-foreground">今日还可提交 {permission.remainingToday} 个工单</div>
          ) : permissionUnavailable ? (
            <div className="text-xs text-amber-600 dark:text-amber-400">资格状态暂不可用，提交时将由服务端校验</div>
          ) : null}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">标题</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="简要描述工单标题"
              maxLength={200}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label className="text-sm font-medium text-foreground">
                附件
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">选填，最多 3 个</span>
              </label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={attachments.length >= MAX_ATTACHMENT_COUNT || submitting}
              >
                <Upload />
                选择文件
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".jpg,.jpeg,.png,.gif,.mkv,.mp4,image/jpeg,image/png,image/gif,video/x-matroska,video/mp4"
                multiple
                className="hidden"
                onChange={(event) => handleFiles(Array.from(event.target.files || []))}
              />
            </div>
            <p className="text-xs text-muted-foreground">支持 JPG、PNG、GIF、MKV、MP4；图片 10 MB，视频 100 MB，总计 200 MB</p>
            {attachments.length > 0 && (
              <div className="divide-y divide-border/50 rounded-lg border border-border/60">
                {attachments.map((file, index) => {
                  // 单请求顺序上传，按文件大小占比拆分整体进度，得到每个文件的分段进度
                  const share = totalAttachmentBytes > 0 ? file.size / totalAttachmentBytes : 0;
                  const filePercent = Math.min(100, Math.round((uploadProgress ?? 0) * share * 100) / 100);
                  const fileLoaded = Math.min(file.size, Math.round(totalAttachmentBytes * (uploadProgress ?? 0) / 100 * share));
                  return (
                  <div key={`${file.name}-${file.size}-${index}`} className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      {file.type.startsWith("image/") ? <FileImage className="size-4 shrink-0" /> : <FileVideo className="size-4 shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-foreground" title={file.name}>{file.name}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {submitting && uploadProgress !== null
                            ? `${formatAttachmentSize(fileLoaded)} / ${formatAttachmentSize(file.size)}`
                            : formatAttachmentSize(file.size)}
                        </p>
                      </div>
                      {submitting && uploadProgress !== null && (
                        <span className={`text-xs tabular-nums ${filePercent >= 100 ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>
                          {filePercent >= 100 ? "完成" : `${filePercent.toFixed(0)}%`}
                        </span>
                      )}
                      <Button type="button" variant="ghost" size="icon-sm" onClick={() => removeAttachment(index)} disabled={submitting} title="删除附件">
                        <Trash2 />
                      </Button>
                    </div>
                    {submitting && uploadProgress !== null && (
                      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className={`h-full rounded-full transition-all duration-200 ${filePercent >= 100 ? "bg-emerald-500" : "bg-blue-500"}`}
                          style={{ width: `${Math.min(100, filePercent)}%` }}
                        />
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
            )}
            {submitting && uploadProgress !== null && attachments.length > 0 && (
              <div className="space-y-1.5 rounded-lg border border-border/60 bg-muted/20 p-3">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{uploadProgress >= 100 ? "附件上传完成，等待服务器处理..." : "附件上传中"}</span>
                  <span className="tabular-nums">{uploadProgress}%</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-200"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">分类</label>
            <Select
              options={CATEGORY_OPTIONS}
              value={category}
              onChange={(v) => setCategory(String(v))}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">
              详细描述
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="请详细描述遇到的问题或建议，包括操作步骤、预期结果和实际结果"
              rows={5}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-none"
            />
          </div>

          {/* 联系方式：选填，已从账号信息预填，可清空实现匿名 */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">
              联系方式
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                选填，方便我们回复你
              </span>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <Input
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                placeholder="邮箱（可清空匿名）"
                maxLength={200}
              />
              <Input
                type="tel"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                placeholder="手机号（可清空匿名）"
                maxLength={50}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || !captchaReady || permissionLoading || permission?.allowed === false}>
            {submitting ? "提交中..." : captchaReady ? <><Paperclip />提交工单</> : "加载验证码..."}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
