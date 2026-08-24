import React, { cloneElement, isValidElement, useId } from "react";

const VARIANTS = new Set(["primary", "secondary", "danger", "ghost"]);

export function Btn({
  children,
  onClick,
  disabled,
  loading = false,
  status,
  variant = "primary",
  title,
  className = "",
  block = false,
}) {
  const interactionState = loading ? "loading" : status || (disabled ? "disabled" : "idle");
  const safeVariant = VARIANTS.has(variant) ? variant : "primary";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      aria-disabled={disabled || loading || undefined}
      aria-busy={loading || undefined}
      data-state={interactionState}
      data-variant={safeVariant}
      title={title}
      className={`cardev-button ${block ? "cardev-button--block" : ""} ${className}`}
    >
      {loading && <span className="cardev-button__spinner" aria-hidden="true" />}
      <span>{children}</span>
    </button>
  );
}

export function Card({ title, children, action }) {
  return (
    <section className="cardev-card">
      {title && (
        <header className="cardev-card__header">
          <h3>{title}</h3>
          {action && <div className="cardev-card__action">{action}</div>}
        </header>
      )}
      <div className="cardev-card__body">{children}</div>
    </section>
  );
}

export function Field({ label, hint, error, children }) {
  const generatedId = useId();
  const controlId = isValidElement(children) && children.props.id ? children.props.id : generatedId;
  const helperId = `${controlId}-helper`;
  const control = isValidElement(children)
    ? cloneElement(children, {
        id: controlId,
        "aria-describedby": hint || error ? helperId : undefined,
        "aria-invalid": error ? true : children.props["aria-invalid"],
      })
    : children;
  return (
    <div className="cardev-field">
      {label && <label className="cardev-field__label" htmlFor={controlId}>{label}</label>}
      {control}
      <p id={helperId} className={`cardev-field__helper ${error ? "is-error" : ""}`}>
        {error || hint || "\u00a0"}
      </p>
    </div>
  );
}

export function Input({
  value,
  onChange,
  placeholder,
  type = "text",
  min,
  max,
  step,
  onKeyDown,
  id,
  disabled,
  loading = false,
  state = "idle",
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}) {
  return (
    <input
      id={id}
      type={type}
      value={value ?? ""}
      onChange={(event) => onChange?.(event.target.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      aria-busy={loading || undefined}
      aria-describedby={ariaDescribedBy}
      aria-invalid={ariaInvalid}
      data-state={loading ? "loading" : ariaInvalid ? "error" : state}
      className="cardev-input"
    />
  );
}

export function Select({ value, onChange, options, id, disabled, loading = false, state = "idle", "aria-describedby": ariaDescribedBy, "aria-invalid": ariaInvalid }) {
  return (
    <select
      id={id}
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      aria-busy={loading || undefined}
      aria-describedby={ariaDescribedBy}
      aria-invalid={ariaInvalid}
      data-state={loading ? "loading" : ariaInvalid ? "error" : state}
      className="cardev-select"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}

export function ButtonGrid({ items, onClick, disabled, minWidth = 130 }) {
  return (
    <div
      className="cardev-button-grid"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${minWidth}px), 1fr))` }}
    >
      {items.map((item) => (
        <Btn key={item.key} onClick={() => onClick(item.key)} disabled={disabled} block>
          {item.label}
        </Btn>
      ))}
    </div>
  );
}

export function Grid({ children, minWidth = 360 }) {
  return (
    <div
      className="cardev-grid"
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${minWidth}px), 1fr))` }}
    >
      {children}
    </div>
  );
}

export function StatusBar({ status }) {
  if (!status) return null;
  const tone = status.type === "ok" ? "success" : status.type === "err" ? "danger" : "info";
  return (
    <div className="cardev-status-dock">
      <div
        className="cardev-status"
        data-tone={tone}
        role={tone === "danger" ? "alert" : "status"}
        aria-live={tone === "danger" ? "assertive" : "polite"}
      >
        {status.text}
      </div>
    </div>
  );
}
