/* oxlint-disable shadcn/no-arbitrary-values -- The panel's 15px option labels and 13px summaries and previews are design-specified sizes between the text-sm and text-base scale. */
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
} from "lucide-react";
import { BackgroundThreadContext } from "./backgroundThread";
import { useStableCallback } from "~/hooks/useStableCallback";
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

type PendingUserInputViewMode = "single" | "all";

const VIEW_MODE_STORAGE_KEY = "t3code:pending-user-input:view-mode";
const HEIGHT_EXPANDED_STORAGE_KEY = "t3code:pending-user-input:height-expanded";

function readViewModePreference(): PendingUserInputViewMode {
  try {
    return window.localStorage.getItem(VIEW_MODE_STORAGE_KEY) === "all" ? "all" : "single";
  } catch {
    return "single";
  }
}

function writeViewModePreference(viewMode: PendingUserInputViewMode): void {
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

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  disabled?: boolean;
  respondingRequestIds: RuntimeRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionValue: string) => void;
  onAdvance: () => void;
  onDismiss: (requestId: RuntimeRequestId) => void;
  onSelectQuestionIndex?: ((questionIndex: number) => void) | undefined;
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
  onAdvance,
  onDismiss,
  onSelectQuestionIndex,
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
      onAdvance={onAdvance}
      onDismiss={onDismiss}
      onSelectQuestionIndex={onSelectQuestionIndex}
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
  onAdvance,
  onDismiss,
  onSelectQuestionIndex,
}: {
  prompt: PendingUserInput;
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  disabled: boolean;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionValue: string) => void;
  onAdvance: () => void;
  onDismiss: (requestId: RuntimeRequestId) => void;
  onSelectQuestionIndex?: ((questionIndex: number) => void) | undefined;
}) {
  const gt = useGT();
  // Message-mode requests remain answerable after their provider turn ends.
  const canRespond = prompt.responseCapability !== "not_resumable";
  const responseDisabled = disabled || isResponding || !canRespond;
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const advance = useStableCallback(onAdvance);
  const [optimisticSingleSelect, setOptimisticSingleSelect] = useState<{
    questionId: string;
    optionValue: string;
  } | null>(null);
  const [collapsedQuestionId, setCollapsedQuestionId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<PendingUserInputViewMode>(readViewModePreference);
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

  if (optimisticSingleSelect) {
    const question = prompt.questions.find(
      (candidate) => candidate.id === optimisticSingleSelect.questionId,
    );
    const answer = question ? answers[question.id] : undefined;
    const customAnswer = question?.allowCustomAnswer === false ? "" : (answer?.customAnswer ?? "");
    const selectedOptionValues = question
      ? normalizeSelectedOptionValues(question, answer?.selectedOptionValues)
      : [];
    if (
      !question ||
      question.multiSelect ||
      (!customAnswer.trim() && selectedOptionValues.includes(optimisticSingleSelect.optionValue))
    ) {
      setOptimisticSingleSelect(null);
    }
  }

  const clearAutoAdvance = useStableCallback(() => {
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
      autoAdvanceTimerRef.current = null;
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the auto-advance timer when the question changes, input is disabled, or the panel unmounts
  useEffect(() => {
    if (disabled || activeQuestion?.id === undefined) clearAutoAdvance();
    return clearAutoAdvance;
  }, [activeQuestion?.id, clearAutoAdvance, disabled]);

  const handleSelectQuestionIndex = (nextIndex: number) => {
    clearAutoAdvance();
    const rawIndex = Number.isFinite(nextIndex) ? Math.trunc(nextIndex) : 0;
    const clampedIndex = Math.max(0, Math.min(rawIndex, prompt.questions.length - 1));
    onSelectQuestionIndex?.(clampedIndex);
  };

  const handleToggleViewMode = () => {
    clearAutoAdvance();
    const nextViewMode = viewMode === "all" ? "single" : "all";
    setViewMode(nextViewMode);
    writeViewModePreference(nextViewMode);
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
    if (targetQuestion.multiSelect) {
      clearAutoAdvance();
      onToggleOption(questionId, optionValue);
      return;
    }
    setOptimisticSingleSelect({ questionId, optionValue });
    onToggleOption(questionId, optionValue);
    // "All" view keeps every card visible, so advancing would skip the card the user is reading.
    if (effectiveViewMode !== "single") return;
    clearAutoAdvance();
    autoAdvanceTimerRef.current = window.setTimeout(() => {
      autoAdvanceTimerRef.current = null;
      advance();
    }, 200);
  };

  const selectOptionFromShortcut = useEffectEvent(handleOptionSelection);
  const backgroundThread = use(BackgroundThreadContext);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes a document keydown listener for digit shortcuts while a question is answerable
  useEffect(() => {
    if (!activeQuestion || responseDisabled || isCollapsed || backgroundThread) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
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

  if (!activeQuestion) {
    return null;
  }

  const promptDirection = markdownProseDirection(
    prompt.questions
      .flatMap((question) => [
        question.header,
        question.question,
        ...question.options.flatMap((option) => [option.label, option.description ?? ""]),
      ])
      .join(" "),
  );
  const questionTextAlign = promptDirection === "rtl" ? "text-right" : "text-left";

  const questionCustomAnswer = (question: ThreadUserInputQuestion) =>
    question.allowCustomAnswer === false ? "" : (answers[question.id]?.customAnswer ?? "");

  const renderQuestionBlock = (
    question: ThreadUserInputQuestion,
    options: { showShortcuts: boolean; onSelect: (optionValue: string) => void },
  ) => {
    const answer = answers[question.id];
    const selectedOptionValues = normalizeSelectedOptionValues(
      question,
      answer?.selectedOptionValues,
    );
    const customAnswer = questionCustomAnswer(question);
    const hasCustomAnswer = customAnswer.trim().length > 0;
    const optimisticValue =
      optimisticSingleSelect?.questionId === question.id
        ? optimisticSingleSelect.optionValue
        : null;
    return (
      <>
        <ChatMarkdown
          text={question.question}
          cwd={cwd}
          threadRef={threadRef}
          lineBreaks
          className={cn(
            "pt-0.5 text-base leading-relaxed font-medium text-foreground",
            questionTextAlign,
          )}
        />
        <div className="mt-2.5 space-y-1">
          {question.options.map((option, optionIndex) => {
            const optionValue = option.value ?? option.label;
            const isSelected =
              optimisticValue === optionValue ||
              (!hasCustomAnswer && selectedOptionValues.includes(optionValue));
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
                    "group flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/35",
                    isSelected
                      ? "bg-primary/8 text-foreground ring-1 ring-inset ring-primary/25"
                      : "bg-transparent text-foreground/85 hover:bg-muted/40",
                    (disabled || isResponding) && "opacity-50 cursor-not-allowed",
                    !disabled && !isResponding && "cursor-pointer",
                  )}
                >
                  <span className="pointer-events-none flex h-[22px] shrink-0 items-center">
                    {question.multiSelect ? (
                      <CheckboxMark checked={isSelected} variant="contrast" />
                    ) : (
                      <OptionRadio checked={isSelected} />
                    )}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span
                      className="text-[15px] leading-snug font-medium"
                      dir={textDirection(option.label)}
                    >
                      {option.label}
                    </span>
                    {option.description && option.description !== option.label ? (
                      <span
                        className="text-[13px] leading-relaxed text-secondary-label"
                        dir={textDirection(option.description)}
                      >
                        {option.description}
                      </span>
                    ) : null}
                  </div>
                  {options.showShortcuts && optionIndex < 9 ? (
                    <span className="flex h-[22px] w-7 shrink-0 items-center justify-center sm:w-6">
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
                    className="ps-9 pe-2 pb-1.5 text-[13px] leading-relaxed text-foreground/75"
                  />
                ) : null}
              </div>
            );
          })}
        </div>
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
          <span
            className={cn(
              "min-w-0 truncate text-xs font-medium text-muted-foreground",
              isCollapsed && "max-w-1/2",
            )}
            dir={textDirection(activeQuestion.header)}
          >
            {activeQuestion.header}
          </span>
          {isCollapsed ? (
            <>
              <ComposerBanner.Separator />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[13px] text-secondary-label",
                  questionTextAlign,
                )}
                dir={markdownProseDirection(activeQuestion.question)}
              >
                {activeQuestion.question}
              </span>
            </>
          ) : hasMultipleQuestions ? (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {gt("{answered}/{total} answered", {
                answered: progress.answeredQuestionCount,
                total: prompt.questions.length,
              })}
            </span>
          ) : null}
        </CollapsibleTrigger>
        <ComposerBanner.Actions className="gap-1">
          {hasMultipleQuestions ? (
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
            </>
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
        {hasMultipleQuestions ? (
          <div
            role="navigation"
            aria-label={gt("Questions")}
            data-pending-user-input-stepper
            className="flex items-center gap-1.5 overflow-x-auto border-y border-border/50 bg-muted/20 px-4 py-1.5"
          >
            {prompt.questions.map((question, index) => {
              const isActive = index === safeQuestionIndex;
              const isAnswered = answeredQuestionIdSet.has(question.id);
              return (
                <button
                  type="button"
                  key={question.id}
                  data-pending-question-tab={index}
                  aria-current={isActive ? "step" : undefined}
                  // oxlint-disable-next-line t3code/no-native-title-tooltip -- the tab's title names its truncated header; the full label sits in the card below
                  title={question.header}
                  disabled={isResponding || !onSelectQuestionIndex}
                  onClick={() => {
                    handleSelectQuestionIndex(index);
                    if (effectiveViewMode === "all") {
                      questionCardRefs.current
                        .get(question.id)
                        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
                    }
                  }}
                  className={cn(
                    "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                    isActive
                      ? "border-primary/45 bg-primary/12 font-medium text-foreground"
                      : isAnswered
                        ? "border-border/70 bg-background/70 text-foreground/85 hover:bg-muted/50"
                        : "border-transparent bg-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                  )}
                >
                  {isAnswered ? (
                    <CheckIcon className="size-3 shrink-0 text-primary" aria-hidden />
                  ) : (
                    <span className="tabular-nums opacity-75">{index + 1}</span>
                  )}
                  <span className="max-w-44 truncate" dir={textDirection(question.header)}>
                    {question.header}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
        <ComposerBanner.Scroll
          className={isHeightExpanded ? "max-h-[min(48rem,76dvh)]" : "max-h-[min(36rem,58dvh)]"}
        >
          <ComposerBanner.Body className="px-5 pt-2 pb-2.5 wrap-anywhere">
            {effectiveViewMode === "all" ? (
              <div className="space-y-3">
                {/* oxlint-disable-next-line react/refs -- the callback ref only stores card elements after commit; no ref value is read while rendering */}
                {prompt.questions.map((question, index) => {
                  const isActive = index === safeQuestionIndex;
                  const isAnswered = answeredQuestionIdSet.has(question.id);
                  const questionCustomAnswerValue = questionCustomAnswer(question);
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
                        <span className="text-xs font-medium text-muted-foreground tabular-nums">
                          {index + 1}.
                        </span>
                        <span
                          className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
                          dir={textDirection(question.header)}
                        >
                          {question.header}
                        </span>
                        {isActive ? (
                          <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                        ) : null}
                        {isAnswered ? (
                          <CheckIcon className="size-3.5 shrink-0 text-primary" aria-hidden />
                        ) : null}
                      </div>
                      {renderQuestionBlock(question, {
                        showShortcuts: isActive,
                        onSelect: (optionValue) =>
                          handleOptionSelection(question.id, optionValue, index),
                      })}
                      {questionCustomAnswerValue.trim().length > 0 ? (
                        <div className="mt-2 rounded-md border border-border/50 bg-muted/30 px-2.5 py-1.5 text-xs text-foreground/80">
                          <span className="font-medium text-muted-foreground">
                            {gt("Custom answer")}:{" "}
                          </span>
                          <span>{questionCustomAnswerValue}</span>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              // oxlint-disable-next-line react/refs -- renderQuestionBlock only renders; the card ref map is written by callback refs after commit
              renderQuestionBlock(activeQuestion, {
                showShortcuts: true,
                onSelect: (optionValue) => handleOptionSelection(activeQuestion.id, optionValue),
              })
            )}
          </ComposerBanner.Body>
        </ComposerBanner.Scroll>
      </CollapsiblePanel>
    </Collapsible>
  );
});

// Drawn with ui/radio-group's look instead of using its Radio: Radio only checks inside a
// RadioGroup, whose arrow keys select options and would trip the single-select auto-advance.
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
