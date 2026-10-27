import { useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";

export function PasswordInput({ className, revealLabel = "비밀번호", ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { revealLabel?: string }) {
  const [visible, setVisible] = useState(false);
  return <span className="password-field">
    <input {...props} className={className} type={visible ? "text" : "password"} />
    <button type="button" className="password-toggle" aria-label={`${revealLabel} ${visible ? "숨기기" : "보기"}`} aria-pressed={visible} disabled={props.disabled} onClick={() => setVisible(value => !value)}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button>
  </span>;
}
