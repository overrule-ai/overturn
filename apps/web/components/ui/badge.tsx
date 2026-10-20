import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

// Bordered chips with a status dot: colour marks the verdict, the chrome stays grey.
const badgeVariants = cva(
  "inline-flex h-5 items-center gap-1.5 rounded-[4px] border px-1.5 text-[11px] font-medium leading-none tabular-nums before:h-1.5 before:w-1.5 before:rounded-full before:content-['']",
  {
    variants: {
      variant: {
        default: "border-border bg-secondary text-foreground before:hidden",
        secondary: "border-border bg-secondary text-muted-foreground before:hidden",
        outline: "border-border text-foreground before:hidden",
        success: "border-success/25 bg-success/10 text-success before:bg-success",
        warning: "border-warning/25 bg-warning/10 text-warning before:bg-warning",
        danger: "border-danger/25 bg-danger/10 text-danger before:bg-danger",
        info: "border-border bg-secondary text-foreground before:bg-info",
        muted: "border-border bg-transparent text-muted-foreground before:bg-muted-foreground/60",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
