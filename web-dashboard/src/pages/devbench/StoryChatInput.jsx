import React, {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { resolveStoryInputSubmission } from "./storyInputDraftModel.mjs";

const DRAFT_PERSIST_DELAY_MS = 180;

function readDraft(draftKey) {
  try {
    return localStorage.getItem(draftKey) || "";
  } catch {
    return "";
  }
}

function persistDraft(draftKey, value) {
  try {
    if (value) localStorage.setItem(draftKey, value);
    else localStorage.removeItem(draftKey);
  } catch {}
}

const StoryChatInput = memo(forwardRef(function StoryChatInput({
  draftKey,
  history = [],
  nextSuggestion = "",
  primary = false,
  disabled = false,
  placeholder = "",
  onSubmit,
  onPaste,
}, ref) {
  const initialValue = useMemo(() => readDraft(draftKey), [draftKey]);
  const searchableHistory = useMemo(
    () => (Array.isArray(history) ? history : []).filter((item) => typeof item === "string").slice(-200),
    [history],
  );
  const [value, setValue] = useState(initialValue);
  const valueRef = useRef(initialValue);
  const revisionRef = useRef(0);
  const pendingSubmissionRef = useRef(null);
  const textareaRef = useRef(null);
  const historyRef = useRef(searchableHistory);
  const historyIndexRef = useRef(-1);
  const historyDraftRef = useRef("");
  const [caretEnd, setCaretEnd] = useState(true);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(0);

  useEffect(() => {
    historyRef.current = searchableHistory;
  }, [searchableHistory]);

  const updateValue = useCallback((nextValue, { persistNow = false } = {}) => {
    const next = String(nextValue ?? "");
    valueRef.current = next;
    revisionRef.current += 1;
    setValue(next);
    if (persistNow) persistDraft(draftKey, next);
    return revisionRef.current;
  }, [draftKey]);

  useEffect(() => {
    const pending = pendingSubmissionRef.current;
    if (pending && revisionRef.current === pending.clearedRevision && value === "") return undefined;
    const timer = setTimeout(() => persistDraft(draftKey, value), DRAFT_PERSIST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draftKey, value]);

  useEffect(() => () => {
    const pending = pendingSubmissionRef.current;
    const currentValue = valueRef.current;
    if (pending && revisionRef.current === pending.clearedRevision && currentValue === "") {
      persistDraft(draftKey, pending.value);
      return;
    }
    persistDraft(draftKey, currentValue);
  }, [draftKey]);

  useImperativeHandle(ref, () => ({
    snapshot() {
      return { value: valueRef.current, revision: revisionRef.current };
    },
    beginSubmission(snapshot = null) {
      const submitted = snapshot || { value: valueRef.current, revision: revisionRef.current };
      if (Number(submitted.revision) !== revisionRef.current || String(submitted.value ?? "") !== valueRef.current) {
        return null;
      }
      const submission = {
        value: valueRef.current,
        revision: revisionRef.current,
        clearedRevision: revisionRef.current + 1,
      };
      pendingSubmissionRef.current = submission;
      persistDraft(draftKey, submission.value);
      valueRef.current = "";
      revisionRef.current = submission.clearedRevision;
      setValue("");
      setSuggestionsOpen(false);
      historyIndexRef.current = -1;
      return submission;
    },
    settleSubmission(submission, ok, { restoreOnFailure = true } = {}) {
      if (!submission) return { restored: false, value: valueRef.current };
      const resolved = resolveStoryInputSubmission({
        submission,
        currentValue: valueRef.current,
        currentRevision: revisionRef.current,
        ok,
        restoreAllowed: restoreOnFailure,
      });
      pendingSubmissionRef.current = null;
      if (resolved.restored) {
        updateValue(resolved.value, { persistNow: true });
        queueMicrotask(() => textareaRef.current?.focus());
      } else {
        persistDraft(draftKey, resolved.value);
      }
      return resolved;
    },
    clear() {
      pendingSubmissionRef.current = null;
      updateValue("", { persistNow: true });
      setSuggestionsOpen(false);
      historyIndexRef.current = -1;
    },
    focus() {
      textareaRef.current?.focus();
    },
  }), [draftKey, updateValue]);

  const computeSuggestion = useCallback((draft) => {
    if (!draft || !draft.trim()) return "";
    const items = historyRef.current;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (items[index] !== draft && items[index].startsWith(draft)) return items[index];
    }
    return "";
  }, []);

  const matches = useMemo(() => {
    if (!primary) return [];
    const query = value.trim().toLowerCase();
    if (!query) return [];
    const seen = new Set();
    const prefix = [];
    const contains = [];
    const items = historyRef.current;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (!item || item === value || seen.has(item)) continue;
      const lower = item.toLowerCase();
      if (lower.startsWith(query)) {
        seen.add(item);
        prefix.push(item);
      } else if (lower.includes(query)) {
        seen.add(item);
        contains.push(item);
      }
      if (prefix.length + contains.length >= 8) break;
    }
    return [...prefix, ...contains].slice(0, 8);
  }, [primary, searchableHistory, value]);

  const suggestion = !primary
    ? ""
    : (value ? (caretEnd ? computeSuggestion(value) : "") : String(nextSuggestion || ""));
  const suggestionTail = suggestion ? suggestion.slice(value.length) : "";
  const showSuggestions = suggestionsOpen && matches.length > 0 && !suggestion;

  const acceptSuggestion = useCallback((item) => {
    updateValue(item);
    setSuggestionsOpen(false);
    historyIndexRef.current = -1;
  }, [updateValue]);

  function handleKeyDown(event) {
    if (event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onSubmit?.();
      return;
    }
    const element = event.target;
    const items = historyRef.current;
    const atEnd = element.selectionStart === value.length && element.selectionEnd === value.length;

    if (suggestion && atEnd && (event.key === "ArrowRight" || event.key === "Tab")) {
      event.preventDefault();
      acceptSuggestion(suggestion);
      return;
    }
    if (showSuggestions) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSuggestionIndex((index) => (index + 1) % matches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSuggestionIndex((index) => (index - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        acceptSuggestion(matches[Math.min(suggestionIndex, matches.length - 1)]);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        acceptSuggestion(matches[Math.min(suggestionIndex, matches.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSuggestionsOpen(false);
        return;
      }
    }
    if (event.key === "ArrowUp" && element.selectionStart === 0 && element.selectionEnd === 0) {
      if (!items.length) return;
      event.preventDefault();
      if (historyIndexRef.current === -1) {
        historyDraftRef.current = value;
        historyIndexRef.current = items.length - 1;
      } else if (historyIndexRef.current > 0) {
        historyIndexRef.current -= 1;
      }
      updateValue(items[historyIndexRef.current]);
    } else if (event.key === "ArrowDown" && atEnd) {
      if (historyIndexRef.current === -1) return;
      event.preventDefault();
      if (historyIndexRef.current < items.length - 1) {
        historyIndexRef.current += 1;
        updateValue(items[historyIndexRef.current]);
      } else {
        historyIndexRef.current = -1;
        updateValue(historyDraftRef.current);
      }
    }
  }

  return (
    <div className="relative">
      {primary && suggestionTail && (
        <div aria-hidden className="absolute inset-0 px-3 py-2 text-sm leading-normal whitespace-pre-wrap break-words pointer-events-none overflow-hidden text-zinc-500">
          <span className="invisible">{value}</span>{suggestionTail}
        </div>
      )}
      {showSuggestions && (
        <div className="absolute left-0 right-0 bottom-full mb-1 z-30 bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl overflow-hidden">
          <div className="px-2 py-1 text-[10px] text-zinc-600 border-b border-zinc-800">历史联想（↑↓ 选择，Enter/Tab 补全，Esc 关闭）</div>
          <div className="max-h-56 overflow-y-auto py-1">
            {matches.map((item, index) => (
              <button
                key={item}
                type="button"
                onMouseDown={(event) => { event.preventDefault(); acceptSuggestion(item); }}
                onMouseEnter={() => setSuggestionIndex(index)}
                className={`w-full text-left px-3 py-1.5 text-[12px] truncate whitespace-nowrap transition ${
                  index === suggestionIndex ? "bg-blue-600/30 text-white" : "text-zinc-300 hover:bg-zinc-800"
                }`}
                title={item}
              >{item}</button>
            ))}
          </div>
        </div>
      )}
      <textarea
        ref={textareaRef}
        data-testid="devbench-story-input"
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          updateValue(next);
          historyIndexRef.current = -1;
          setCaretEnd(event.target.selectionStart === next.length);
          setSuggestionsOpen(next.trim().length > 0);
          setSuggestionIndex(0);
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={(event) => setCaretEnd(event.target.selectionStart === event.target.value.length)}
        onClick={(event) => setCaretEnd(event.target.selectionStart === event.target.value.length)}
        onBlur={() => setTimeout(() => setSuggestionsOpen(false), 150)}
        onPaste={onPaste}
        placeholder={suggestionTail ? "" : placeholder}
        rows={2}
        disabled={disabled}
        className="relative w-full bg-transparent rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none resize-none disabled:opacity-50 leading-normal"
      />
    </div>
  );
}));

export default StoryChatInput;
