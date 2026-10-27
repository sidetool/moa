import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { cx } from "../../lib/format";

type Variant = "primary" | "secondary" | "ghost" | "accent";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "m" | "l";
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "secondary", size = "m", icon, className, children, ...rest }, ref) {
  return (
    <button ref={ref} className={cx("btn", `btn-${variant}`, `btn-${size}`, !children && "btn-icon-only", className)} {...rest}>
      {icon}
      {children && <span>{children}</span>}
    </button>
  );
});

export function ButtonLink({ to, variant = "secondary", size = "m", icon, children, className }: { to: string; variant?: Variant; size?: "m" | "l"; icon?: ReactNode; children: ReactNode; className?: string }) {
  return <Link to={to} className={cx("btn", `btn-${variant}`, `btn-${size}`, className)}>{icon}<span>{children}</span></Link>;
}

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button aria-label={label} title={label} className={cx("icon-btn", className)} {...rest}>{children}</button>;
}
