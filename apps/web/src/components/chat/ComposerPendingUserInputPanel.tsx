/* oxlint-disable shadcn/no-arbitrary-values -- The panel keeps design-specified sizes off the text-sm/text-base scale: text-[15px] for the question stem, text-[13px] for option labels, and text-[11px] for the recommendation badge. */
import { type RuntimeRequestId, type ScopedThreadRef } from "@t3tools/contracts";
import { markdownProseDirection, textDirection } from "~/textDirection";
import { useGT } from "gt-react";
import { memo, use, useEffect, useEffectEvent, useRef, useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ListIcon,
  Maximize2Icon,
  Minimize2Icon,
  PenLineIcon,
} from "lucide-react";
import { BackgroundThreadContext } from "./backgroundThread";
import { type PendingUserInput } from "../../session-logic";
import {
  normalizeSelectedOptionValues,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import type { ThreadUserInputQuestion } from "@t3tools/client-runtime/state/thread-requests";
import { derivePendingUserInputProgress } from "../../pendingUserInput";
import { Button } from "../ui/button";
import { CheckboxMark } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Kbd } from "../ui/kbd";
import { cn } from "~/lib/utils";
import { isInSideChatPane } from "~/lib/sideChatPane";
import { ComposerBanner } from "./ComposerBanner";
import ChatMarkdown from "../ChatMarkdown";

export type PendingUserInputViewMode = "single" | "all";

const VIEW_MODE_STORAGE_KEY = "t3code:pending-user-input:view-mode";
const HEIGHT_EXPANDED_STORAGE_KEY = "t3code:pending-user-input:height-expanded";

export function readPendingUserInputViewModePreference(): PendingUserInputViewMode {
  try {
    return window.localStorage.getItem(VIEW_MODE_STORAGE_KEY) === "all" ? "all" : "single";
  } catch {
    return "single";
  }
}

export function writePendingUserInputViewModePreference(viewMode: PendingUserInputViewMode): void {
  try {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
  } catch {}
}

function readHeightExpandedPreference(): boolean {
  try {
    return window.localStorage.getItem(HEIGHT_EXPANDED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeHeightExpandedPreference(expanded: boolean): void {
  try {
    window.localStorage.setItem(HEIGHT_EXPANDED_STORAGE_KEY, String(expanded));
  } catch {}
}

/**
 * Providers that cannot enumerate their questions send the real question in `header` and a
 * generic line in `question`, so the panel swaps them and numbers the header itself.
 */
const GENERIC_ELICITATION_QUESTION_RE = /^The agent has (?:\d+ questions?|a question)\.?$/i;
const GENERIC_NUMBERED_HEADER_RE = /^Question\s+(\d+)$/i;
const GENERIC_BARE_HEADER_RE = /^Question$/i;

interface QuestionPresentation {
  header: string;
  isNumberedHeader: boolean;
  question: string;
}

function resolveQuestionPresentation(
  question: { header: string; question: string },
  index: number,
  gt: ReturnType<typeof useGT>,
): QuestionPresentation {
  const trimmedHeader = question.header.trim();
  const trimmedQuestion = question.question.trim();
  if (
    GENERIC_ELICITATION_QUESTION_RE.test(trimmedQuestion) &&
    trimmedHeader.length > 0 &&
    !GENERIC_BARE_HEADER_RE.test(trimmedHeader) &&
    !GENERIC_NUMBERED_HEADER_RE.test(trimmedHeader)
  ) {
    return {
      header: gt("Question {number}", { number: index + 1 }),
      isNumberedHeader: true,
      question: trimmedHeader,
    };
  }
  const numberedHeader = GENERIC_NUMBERED_HEADER_RE.exec(trimmedHeader);
  if (numberedHeader) {
    return {
      header: gt("Question {number}", { number: Number(numberedHeader[1]) }),
      isNumberedHeader: true,
      question: question.question,
    };
  }
  if (GENERIC_BARE_HEADER_RE.test(trimmedHeader)) {
    return { header: gt("Question"), isNumberedHeader: false, question: question.question };
  }
  return { header: question.header, isNumberedHeader: false, question: question.question };
}

/**
 * Strips the "(Recommended)" marker providers append to an option label or description, so the
 * panel can render it as a badge. The option's value is never touched.
 */
function parseRecommendedOptionText(text: string): { text: string; isRecommended: boolean } {
  const leading = /^\(\s*Recommended\s*\)\s*/i.exec(text);
  if (leading) {
    const trimmed = text.slice(leading[0].length).trim();
    if (trimmed.length > 0) return { text: trimmed, isRecommended: true };
  }
  const trailing = /\s*\(\s*Recommended\s*\)$/i.exec(text);
  if (trailing) {
    const trimmed = text.slice(0, trailing.index).trim();
    if (trimmed.length > 0) return { text: trimmed, isRecommended: true };
  }
  return { text, isRecommended: false };
}

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  disabled?: boolean;
  respondingRequestIds: RuntimeRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionValue: string) => void;
  onChangeCustomAnswer?: ((questionId: string, value: string) => void) | undefined;
  onAdvance?: (() => void) | undefined;
  onDismiss: (requestId: RuntimeRequestId) => void;
  onSelectQuestionIndex?: ((questionIndex: number) => void) | undefined;
  viewMode?: PendingUserInputViewMode | undefined;
  onViewModeChange?: ((viewMode: PendingUserInputViewMode) => void) | undefined;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  cwd,
  threadRef,
  disabled = false,
  respondingRequestIds,
  answers,
  questionIndex,
  onToggleOption,
  onChangeCustomAnswer,
  onDismiss,
  onSelectQuestionIndex,
  viewMode,
  onViewModeChange,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      cwd={cwd}
      threadRef={threadRef}
      disabled={disabled}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      questionIndex={questionIndex}
      onToggleOption={onToggleOption}
      onChangeCustomAnswer={onChangeCustomAnswer}
      onDismiss={onDismiss}
      onSelectQuestionIndex={onSelectQuestionIndex}
      viewMode={viewMode}
      onViewModeChange={onViewModeChange}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  cwd,
  threadRef,
  disabled,
  isResponding,
  answers,
  questionIndex,
  onToggleOption,
  onChangeCustomAnswer,
  onDismiss,
  onSelectQuestionIndex,
  viewMode: viewModeProp,
  onViewModeChange,
}: {
  prompt: PendingUserInput;
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  disabled: boolean;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionValue: string) => void;
  onChangeCustomAnswer?: ((questionId: string, value: string) => void) | undefined;
  onDismiss: (requestId: RuntimeRequestId) => void;
  onSelectQuestionIndex?: ((questionIndex: number) => void) | undefined;
  viewMode?: PendingUserInputViewMode | undefined;
  onViewModeChange?: ((viewMode: PendingUserInputViewMode) => void) | undefined;
}) {
  const gt = useGT();
  // Message-mode requests remain answerable after their provider turn ends.
  const canRespond = prompt.responseCapability !== "not_resumable";
  const responseDisabled = disabled || isResponding || !canRespond;
  const [collapsedQuestionId, setCollapsedQuestionId] = useState<string | null>(null);
  const [uncontrolledViewMode, setUncontrolledViewMode] = useState<PendingUserInputViewMode>(
    readPendingUserInputViewModePreference,
  );
  const viewMode = viewModeProp ?? uncontrolledViewMode;
  const [isHeightExpanded, setIsHeightExpanded] = useState<boolean>(readHeightExpandedPreference);
  const questionCardRefs = useRef(new Map<string, HTMLDivElement>());
  // Keep question identity stable for its shortcut listener.
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const safeQuestionIndex = progress.questionIndex;
  const answeredQuestionIdSet = new Set(progress.answeredQuestionIds);
  const hasMultipleQuestions = prompt.questions.length > 1;
  const effectiveViewMode = hasMultipleQuestions ? viewMode : "single";
  const isCollapsed = collapsedQuestionId !== null && collapsedQuestionId === activeQuestion?.id;

  const handleSelectQuestionIndex = (nextIndex: number) => {
    const rawIndex = Number.isFinite(nextIndex) ? Math.trunc(nextIndex) : 0;
    const clampedIndex = Math.max(0, Math.min(rawIndex, prompt.questions.length - 1));
    onSelectQuestionIndex?.(clampedIndex);
  };

  const handleToggleViewMode = () => {
    const nextViewMode = viewMode === "all" ? "single" : "all";
    onViewModeChange?.(nextViewMode);
    if (viewModeProp === undefined) {
      setUncontrolledViewMode(nextViewMode);
      writePendingUserInputViewModePreference(nextViewMode);
    }
  };

  const handleToggleHeightExpanded = () => {
    const nextExpanded = !isHeightExpanded;
    setIsHeightExpanded(nextExpanded);
    writeHeightExpandedPreference(nextExpanded);
  };

  const handleOptionSelection = (
    questionId: string,
    optionValue: string,
    targetQuestionIndex?: number,
  ) => {
    if (disabled || isResponding) return;
    const targetQuestion = prompt.questions.find((question) => question.id === questionId);
    if (!targetQuestion) return;
    if (targetQuestionIndex !== undefined && targetQuestionIndex !== safeQuestionIndex) {
      handleSelectQuestionIndex(targetQuestionIndex);
    }
    // Selecting a single-select option only records the answer. Advancing or
    // submitting stays an explicit user action so a misclick never sends it.
    onToggleOption(questionId, optionValue);
  };

  const selectOptionFromShortcut = useEffectEvent(handleOptionSelection);
  const backgroundThread = use(BackgroundThreadContext);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes a document keydown listener for digit shortcuts while a question is answerable
  useEffect(() => {
    if (!activeQuestion || responseDisabled || isCollapsed || backgroundThread) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (isInSideChatPane(target)) return;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      if (
        target instanceof HTMLElement &&
        target.closest(
          'select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [aria-modal="true"], [role="menu"], [role="combobox"], [data-slot$="popup"]',
        )
      ) {
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const optionIndex = digit - 1;
      if (optionIndex >= activeQuestion.options.length) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      selectOptionFromShortcut(activeQuestion.id, option.value ?? option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, backgroundThread, isCollapsed, responseDisabled]);

  const previousActiveQuestionIdRef = useRef(activeQuestion?.id);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the newly focused question card into view when navigating in all-questions view
  useEffect(() => {
    const previousId = previousActiveQuestionIdRef.current;
    previousActiveQuestionIdRef.current = activeQuestion?.id;
    const activeQuestionId = activeQuestion?.id;
    if (
      effectiveViewMode !== "all" ||
      previousId === undefined ||
      activeQuestionId === undefined ||
      activeQuestionId === previousId
    ) {
      return;
    }
    questionCardRefs.current
      .get(activeQuestionId)
      ?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [activeQuestion?.id, effectiveViewMode]);

  if (!activeQuestion) {
    return null;
  }

  const questionPresentations = prompt.questions.map((question, index) =>
    resolveQuestionPresentation(question, index, gt),
  );
  const activePresentation = questionPresentations[safeQuestionIndex] ?? {
    header: activeQuestion.header,
    isNumberedHeader: false,
    question: activeQuestion.question,
  };
  const promptDirection = markdownProseDirection(
    questionPresentations
      .flatMap((presentation, index) => [
        presentation.header,
        presentation.question,
        ...(prompt.questions[index]?.options ?? []).flatMap((option) => [
          option.label,
          option.description ?? "",
        ]),
      ])
      .join(" "),
  );
  const questionTextAlign = promptDirection === "rtl" ? "text-right" : "text-left";

  const questionCustomAnswer = (question: ThreadUserInputQuestion) =>
    question.allowCustomAnswer === false ? "" : (answers[question.id]?.customAnswer ?? "");

  const renderQuestionBlock = (
    question: ThreadUserInputQuestion,
    presentation: QuestionPresentation,
    options: {
      showShortcuts: boolean;
      questionIndex: number;
      onSelect: (optionValue: string) => void;
    },
  ) => {
    const answer = answers[question.id];
    const selectedOptionValues = normalizeSelectedOptionValues(
      question,
      answer?.selectedOptionValues,
    );
    const customAnswer = questionCustomAnswer(question);
    return (
      <>
        <ChatMarkdown
          text={presentation.question}
          cwd={cwd}
          threadRef={threadRef}
          lineBreaks
          className={cn(
            "pt-0.5 text-[15px] leading-relaxed font-semibold text-foreground",
            questionTextAlign,
          )}
        />
        <div className="mt-2 space-y-1">
          {question.options.map((option, optionIndex) => {
            const optionValue = option.value ?? option.label;
            const parsedLabel = parseRecommendedOptionText(option.label);
            const parsedDescription = option.description
              ? parseRecommendedOptionText(option.description)
              : null;
            const isRecommended =
              parsedLabel.isRecommended || Boolean(parsedDescription?.isRecommended);
            const isSelected = selectedOptionValues.includes(optionValue);
            return (
              <div key={`${question.id}:${optionValue}`}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  disabled={disabled || isResponding}
                  onClick={(event) => {
                    event.stopPropagation();
                    options.onSelect(optionValue);
                  }}
                  className={cn(
                    questionTextAlign,
                    "group flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/35",
                    isSelected
                      ? "bg-primary/8 text-foreground ring-1 ring-inset ring-primary/25"
                      : "bg-transparent text-foreground/85 hover:bg-muted/40",
                    (disabled || isResponding) && "opacity-50 cursor-not-allowed",
                    !disabled && !isResponding && "cursor-pointer",
                  )}
                >
                  <span className="pointer-events-none flex h-5 shrink-0 items-center">
                    {question.multiSelect ? (
                      <CheckboxMark checked={isSelected} variant="contrast" />
                    ) : (
                      <OptionRadio checked={isSelected} />
                    )}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={cn(
                          "text-[13px] leading-snug",
                          isSelected ? "font-medium" : "font-normal",
                        )}
                        dir={textDirection(parsedLabel.text)}
                      >
                        {parsedLabel.text}
                      </span>
                      {isRecommended ? (
                        <span className="inline-flex shrink-0 items-center rounded-sm bg-primary/12 px-1.5 py-0.5 text-[11px] leading-none font-medium text-primary">
                          {gt("Recommended")}
                        </span>
                      ) : null}
                    </div>
                    {parsedDescription &&
                    parsedDescription.text.length > 0 &&
                    parsedDescription.text !== parsedLabel.text ? (
                      <span
                        className="text-xs leading-relaxed text-secondary-label"
                        dir={textDirection(parsedDescription.text)}
                      >
                        {parsedDescription.text}
                      </span>
                    ) : null}
                  </div>
                  {options.showShortcuts && optionIndex < 9 ? (
                    <span className="flex h-5 w-6 shrink-0 items-center justify-center">
                      <Kbd>{optionIndex + 1}</Kbd>
                    </span>
                  ) : null}
                </button>
                {option.preview ? (
                  <ChatMarkdown
                    text={option.preview}
                    cwd={cwd}
                    threadRef={threadRef}
                    lineBreaks
                    className="ps-8 pe-2 pb-1.5 text-xs leading-relaxed text-foreground/75"
                  />
                ) : null}
              </div>
            );
          })}
        </div>
        {question.allowCustomAnswer !== false ? (
          <PendingCustomAnswerInput
            questionId={question.id}
            value={customAnswer}
            hasOptions={question.options.length > 0}
            questionTextAlign={questionTextAlign}
            disabled={disabled || isResponding}
            onChange={(questionId, value) => onChangeCustomAnswer?.(questionId, value)}
            onFocus={() => {
              if (options.questionIndex !== safeQuestionIndex) {
                handleSelectQuestionIndex(options.questionIndex);
              }
            }}
          />
        ) : null}
      </>
    );
  };

  return (
    <Collapsible
      dir={promptDirection}
      open={!isCollapsed}
      onOpenChange={(open) => {
        setCollapsedQuestionId(open ? null : activeQuestion.id);
      }}
    >
      <ComposerBanner.Row className="px-4 py-2">
        <CollapsibleTrigger
          render={<button type="button" />}
          title={
            isCollapsed
              ? gt("Show the question and its options")
              : gt("Hide the question and its options")
          }
          data-pending-user-input-toggle={isCollapsed ? "collapsed" : "expanded"}
          className="col-[1/3] row-start-1 flex min-w-0 cursor-pointer items-center gap-1.5 rounded-lg py-0.5 text-start hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          {isCollapsed ? (
            <>
              <span
                className="min-w-0 max-w-1/2 truncate text-xs font-medium text-muted-foreground"
                dir={textDirection(activePresentation.header)}
              >
                {activePresentation.header}
              </span>
              <ComposerBanner.Separator />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[13px] text-secondary-label",
                  questionTextAlign,
                )}
                dir={markdownProseDirection(activePresentation.question)}
              >
                {activePresentation.question}
              </span>
            </>
          ) : effectiveViewMode === "all" ? (
            <>
              <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">
                {gt("All questions")}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {gt("{answered}/{total} answered", {
                  answered: progress.answeredQuestionCount,
                  total: prompt.questions.length,
                })}
              </span>
            </>
          ) : (
            <>
              <span
                className="min-w-0 truncate text-xs font-medium text-muted-foreground"
                dir={textDirection(activePresentation.header)}
              >
                {activePresentation.header}
              </span>
              {hasMultipleQuestions ? (
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {gt("{answered}/{total} answered", {
                    answered: progress.answeredQuestionCount,
                    total: prompt.questions.length,
                  })}
                </span>
              ) : null}
            </>
          )}
        </CollapsibleTrigger>
        <ComposerBanner.Actions className="gap-1">
          {hasMultipleQuestions && effectiveViewMode === "single" ? (
            <>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={gt("Previous question")}
                title={gt("Previous question")}
                disabled={isResponding || !onSelectQuestionIndex || safeQuestionIndex <= 0}
                data-pending-user-input-prev
                onClick={() => handleSelectQuestionIndex(safeQuestionIndex - 1)}
              >
                <ChevronLeftIcon className="size-3.5" />
              </Button>
              <ComposerBanner.Count className="text-xs">
                {safeQuestionIndex + 1}/{prompt.questions.length}
              </ComposerBanner.Count>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={gt("Next question")}
                title={gt("Next question")}
                disabled={
                  isResponding ||
                  !onSelectQuestionIndex ||
                  safeQuestionIndex >= prompt.questions.length - 1
                }
                data-pending-user-input-next
                onClick={() => handleSelectQuestionIndex(safeQuestionIndex + 1)}
              >
                <ChevronRightIcon className="size-3.5" />
              </Button>
            </>
          ) : null}
          {hasMultipleQuestions ? (
            <Button
              type="button"
              size="xs"
              variant={viewMode === "all" ? "secondary" : "ghost"}
              aria-pressed={viewMode === "all"}
              title={
                viewMode === "all"
                  ? gt("View one question at a time")
                  : gt("View all questions together")
              }
              data-pending-user-input-view-mode={viewMode}
              onClick={handleToggleViewMode}
            >
              <ListIcon className="size-3.5" />
              {viewMode === "all" ? gt("Single") : gt("All")}
            </Button>
          ) : null}
          {!isCollapsed ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-pressed={isHeightExpanded}
              aria-label={
                isHeightExpanded
                  ? gt("Restore question panel height")
                  : gt("Expand question panel height")
              }
              title={
                isHeightExpanded
                  ? gt("Restore question panel height")
                  : gt("Expand question panel height")
              }
              data-pending-user-input-height={isHeightExpanded ? "expanded" : "default"}
              onClick={handleToggleHeightExpanded}
            >
              {isHeightExpanded ? (
                <Minimize2Icon className="size-3.5" />
              ) : (
                <Maximize2Icon className="size-3.5" />
              )}
            </Button>
          ) : null}
          <CollapsibleTrigger
            render={<Button type="button" size="icon-xs" variant="ghost" />}
            aria-label={
              isCollapsed
                ? gt("Show the question and its options")
                : gt("Hide the question and its options")
            }
          >
            <ChevronDownIcon
              className={cn("size-3.5 transition-transform", isCollapsed && "rotate-180")}
            />
          </CollapsibleTrigger>
          {prompt.dismissible ? (
            <ComposerBanner.Dismiss
              render={<span role="button" tabIndex={0} />}
              aria-label={gt("Dismiss question without answering")}
              title={gt("Dismiss question without answering")}
              disabled={isResponding}
              data-pending-user-input-dismiss
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onDismiss(prompt.requestId);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                onDismiss(prompt.requestId);
              }}
            />
          ) : null}
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
      <CollapsiblePanel>
        <ComposerBanner.Scroll
          className={isHeightExpanded ? "max-h-[min(48rem,76dvh)]" : "max-h-[min(36rem,58dvh)]"}
        >
          <ComposerBanner.Body className="px-5 pt-2 pb-2.5 wrap-anywhere">
            {effectiveViewMode === "all" ? (
              <div className="space-y-3">
                {prompt.questions.map((question, index) => {
                  const isActive = index === safeQuestionIndex;
                  const isAnswered = answeredQuestionIdSet.has(question.id);
                  const presentation = questionPresentations[index] ?? {
                    header: question.header,
                    isNumberedHeader: false,
                    question: question.question,
                  };
                  return (
                    <div
                      key={question.id}
                      ref={(element) => {
                        if (element) questionCardRefs.current.set(question.id, element);
                        else questionCardRefs.current.delete(question.id);
                      }}
                      data-pending-question-card={index}
                      data-pending-question-active={isActive ? "true" : "false"}
                      onClick={() => {
                        if (window.getSelection()?.toString()) return;
                        if (!isActive && !isResponding) handleSelectQuestionIndex(index);
                      }}
                      className={cn(
                        "rounded-xl border p-3.5 transition-colors",
                        isActive
                          ? "border-primary/40 bg-background/70"
                          : "border-border/60 bg-background/35 hover:border-border",
                      )}
                    >
                      <div className="mb-2 flex items-center gap-2">
                        {presentation.isNumberedHeader ? null : (
                          <span className="text-xs font-medium text-muted-foreground tabular-nums">
                            {index + 1}.
                          </span>
                        )}
                        <span
                          className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
                          dir={textDirection(presentation.header)}
                        >
                          {presentation.header}
                        </span>
                        {isActive ? (
                          <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                        ) : null}
                        {isAnswered ? (
                          <CheckIcon className="size-3.5 shrink-0 text-primary" aria-hidden />
                        ) : null}
                      </div>
                      {renderQuestionBlock(question, presentation, {
                        showShortcuts: isActive,
                        questionIndex: index,
                        onSelect: (optionValue) =>
                          handleOptionSelection(question.id, optionValue, index),
                      })}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div
                key={activeQuestion.id}
                data-pending-user-input-question-stage
                className="pending-question-enter"
              >
                {renderQuestionBlock(activeQuestion, activePresentation, {
                  showShortcuts: true,
                  questionIndex: safeQuestionIndex,
                  onSelect: (optionValue) => handleOptionSelection(activeQuestion.id, optionValue),
                })}
              </div>
            )}
          </ComposerBanner.Body>
        </ComposerBanner.Scroll>
      </CollapsiblePanel>
    </Collapsible>
  );
});

const CUSTOM_ANSWER_MAX_HEIGHT_PX = 96;

/**
 * The note field sits directly under a question's options so a note and a selected option can
 * coexist. It grows with its content up to a fixed height, then scrolls.
 */
function PendingCustomAnswerInput({
  questionId,
  value,
  hasOptions,
  questionTextAlign,
  disabled,
  onChange,
  onFocus,
}: {
  questionId: string;
  value: string;
  hasOptions: boolean;
  questionTextAlign: string;
  disabled: boolean;
  onChange: (questionId: string, value: string) => void;
  onFocus: () => void;
}) {
  const gt = useGT();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const placeholder = hasOptions
    ? gt("Add a note or type your own answer...")
    : gt("Type your answer...");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the textarea's content height into its inline style so multiline answers grow in place
  useEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = "auto";
    const nextHeight = Math.min(element.scrollHeight, CUSTOM_ANSWER_MAX_HEIGHT_PX);
    element.style.height = `${nextHeight}px`;
    element.style.overflowY =
      element.scrollHeight > CUSTOM_ANSWER_MAX_HEIGHT_PX ? "auto" : "hidden";
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- re-measures whenever the controlled value changes, including draft edits made outside this field
    value,
  ]);

  return (
    <div className="mt-2" onClick={(event) => event.stopPropagation()}>
      <div
        className={cn(
          "flex items-start gap-2 rounded-lg border border-border/60 bg-background/60 px-2.5 py-1.5 transition-colors focus-within:border-primary/40",
          questionTextAlign,
        )}
      >
        <PenLineIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <textarea
          ref={inputRef}
          rows={1}
          dir="auto"
          value={value}
          disabled={disabled}
          data-pending-question-custom-input={questionId}
          aria-label={placeholder}
          placeholder={placeholder}
          onChange={(event) => onChange(questionId, event.target.value)}
          onFocus={onFocus}
          className={cn(
            "max-h-24 min-h-5 w-full resize-none bg-transparent text-[13px] leading-snug text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60",
            questionTextAlign,
          )}
        />
      </div>
    </div>
  );
}

// Drawn with ui/radio-group's look instead of using its Radio: Radio only checks inside a
// RadioGroup, whose arrow keys move the selection for the user.
function OptionRadio({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-4.5 shrink-0 items-center justify-center rounded-full border border-foreground/55 bg-background not-dark:bg-clip-padding sm:size-4 dark:bg-input/32",
        checked ? "shadow-none" : "shadow-xs/5",
      )}
    >
      {checked ? (
        <span className="-inset-px absolute flex items-center justify-center rounded-full bg-primary before:size-2 before:rounded-full before:bg-primary-foreground sm:before:size-1.5" />
      ) : null}
    </span>
  );
}
