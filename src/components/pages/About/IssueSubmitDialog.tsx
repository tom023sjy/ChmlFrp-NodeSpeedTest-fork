/**
 * 提交工单对话框
 *
 * 用户填写标题、描述、分类后，点击提交触发极验 GT4 验证码，
 * 验证通过后调用后端 /api/issues/submit 提交工单。
 */
import { useState, useEffect } from "react";
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
  isBackendAuthenticated,
  getCurrentUser,
  type IssueCategory,
} from "@/services/backendApi";
import { toast } from "sonner";

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
  // 仅在对话框打开时初始化极验（避免不必要的脚本加载）
  const { ready: captchaReady, verify: verifyCaptcha } = useGeetest(open);

  // 重置表单：对话框打开时从当前登录用户预填联系方式（邮箱、手机号）
  useEffect(() => {
    if (open) {
      setTitle("");
      setDescription("");
      setCategory("bug");
      setSubmitting(false);
      const me = getCurrentUser();
      setContactEmail(me?.email || "");
      setContactPhone(me?.phone || "");
    }
  }, [open]);

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

    setSubmitting(true);
    try {
      // 1. 触发极验验证码弹窗
      const geetestResult = await verifyCaptcha();
      if (!geetestResult) {
        toast.error("请完成验证码校验");
        setSubmitting(false);
        return;
      }

      // 2. 提交到后端（含验证码二次校验）
      const res = await submitIssue(
        {
          title: title.trim(),
          description: description.trim(),
          category: category as IssueCategory,
          contactEmail: emailVal,
          contactPhone: phoneVal,
        },
        geetestResult,
      );

      if (res.success) {
        toast.success("工单已提交，我们会尽快处理");
        onOpenChange(false);
        onSuccess?.();
      } else {
        toast.error(res.message || "提交失败");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="z-[10000] max-w-[480px]">
        <DialogHeader>
          <DialogTitle>提交工单</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">标题</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="简要描述工单标题"
              maxLength={200}
            />
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
          <Button onClick={handleSubmit} disabled={submitting || !captchaReady}>
            {submitting ? "提交中..." : captchaReady ? "提交工单" : "加载验证码..."}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
