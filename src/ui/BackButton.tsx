import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Reusable back-navigation control built directly on the shadcn Button —
 * the one place in src/ui allowed to use Tailwind utility classes, since
 * it's a thin wrapper around the shadcn primitive rather than part of the
 * bespoke dashboard.css visual system.
 */
export function BackButton({
  onClick,
  label,
  className,
}: {
  onClick: () => void;
  label?: string;
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size={label ? "sm" : "icon-sm"}
      onClick={onClick}
      aria-label={label ?? "Back"}
      className={`gap-1.5 px-2 text-foreground/80 hover:text-foreground${className ? ` ${className}` : ""}`}
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      {label && <span>{label}</span>}
    </Button>
  );
}
