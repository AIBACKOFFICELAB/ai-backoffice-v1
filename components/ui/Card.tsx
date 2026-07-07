import type { HTMLAttributes } from "react";

type CardProps = HTMLAttributes<HTMLDivElement> & {
  /** Controls background/ring here rather than via `className` — two
   * competing `bg-*` (or `ring-*`) utilities in one class string silently
   * fight over CSS ordering instead of the later one winning predictably. */
  tone?: "light" | "dark" | "highlight";
};

const TONE_CLASSES: Record<NonNullable<CardProps["tone"]>, string> = {
  light: "bg-white ring-surface-border",
  dark: "bg-brand-950 text-white ring-brand-900",
  highlight: "bg-brand-50 ring-brand-100",
};

export function Card({ className = "", tone = "light", ...rest }: CardProps) {
  return <div className={`rounded-card shadow-card ring-1 ${TONE_CLASSES[tone]} ${className}`} {...rest} />;
}

export function CardHeader({ className = "", ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`p-6 pb-4 ${className}`} {...rest} />;
}

export function CardBody({ className = "", ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`p-6 pt-0 ${className}`} {...rest} />;
}
