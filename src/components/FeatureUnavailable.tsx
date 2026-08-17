import { CircleOff } from "lucide-react";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from "@/components/ui/empty";

interface FeatureUnavailableProps {
  title: string;
  reason: string | null;
}

export function FeatureUnavailable({ title, reason }: FeatureUnavailableProps) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="bg-destructive/10 text-destructive">
          <CircleOff className="size-6" />
        </EmptyMedia>
        <EmptyTitle>{title}暂时不可用</EmptyTitle>
        <EmptyDescription>
          {reason || "该功能正在维护，请稍后再试。"}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
