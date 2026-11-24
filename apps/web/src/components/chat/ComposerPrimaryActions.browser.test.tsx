import "~/index.css";

import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
  useClientSettings: () => false,
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));

import { CollapsedComposerStopAction, ComposerPrimaryActions } from "./ComposerPrimaryActions";

function setup() {
  return {
    compact: true,
    canOperateThread: true,
    pendingAction: null,
    isRunning: true,
    canInterrupt: true,
    canResume: false,
    isSendBusy: false,
    sendDisabledReason: null,
    isEnvironmentUnavailable: false,
    isPreparingWorktree: false,
    hasSendableContent: false,
    onPreviousPendingQuestion: vi.fn(),
    onInterrupt: vi.fn(),
    onResume: vi.fn(),
    onSubmitMessage: vi.fn(),
  } satisfies ComponentProps<typeof ComposerPrimaryActions>;
}

it.each(["resume", "draft", "question"] as const)(
  "keeps repeat Stop clicks from reaching the action that replaces it (%s)",
  async (mode) => {
    const props = setup();
    const submit = vi.fn();
    const pendingAction =
      mode === "question"
        ? {
            questionIndex: 0,
            isLastQuestion: true,
            canAdvance: true,
            isResponding: false,
            isComplete: true,
          }
        : null;
    const view = (overrides: Partial<ComponentProps<typeof ComposerPrimaryActions>> = {}) => (
      <form
        style={{ display: "flex", justifyContent: "flex-end", width: "400px" }}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <ComposerPrimaryActions {...props} pendingAction={pendingAction} {...overrides} />
      </form>
    );
    await using screen = await render(view());
    using _timers = fakeTimers();
    const stop = screen
      .getByRole("button", { name: "Stop generation" })
      .element() as HTMLButtonElement;
    const { x, y, width, height } = stop.getBoundingClientRect();
    const target = () =>
      document.elementFromPoint(x + width / 2, y + height / 2)?.closest("button");
    await act(() => stop.click());
    await act(() =>
      (
        screen.getByRole("button", { name: "Stopping", exact: true }).element() as HTMLButtonElement
      ).click(),
    );
    expect(screen.getByRole("button", { name: "Stopping", exact: true }).element()).toBeDisabled();
    expect(props.onInterrupt).toHaveBeenCalledTimes(1);
    await screen.rerender(
      view({
        isRunning: false,
        canInterrupt: false,
        canResume: true,
        hasSendableContent: mode === "draft",
      }),
    );
    const action = { resume: "Resume thread", draft: "Submit message", question: "Submit" }[mode];
    expect(screen.getByRole("button", { name: "Stop generation" }).query()).toBeNull();
    expect(target()).toBe(screen.getByRole("button", { name: action, exact: true }).element());
    await act(() => {
      for (let i = 0; i < 20; i++) target()?.click();
    });
    await act(() => vi.advanceTimersByTime(499));
    await act(() => target()?.click());
    expect(props.onResume).not.toHaveBeenCalled();
    expect(props.onSubmitMessage).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTime(1));
    await act(() => target()?.click());
    expect(
      { resume: props.onResume, draft: props.onSubmitMessage, question: submit }[mode],
    ).toHaveBeenCalledTimes(1);
    await screen.rerender(view());
    expect(screen.getByRole("button", { name: "Stop generation" }).element()).toBeEnabled();
  },
);

it("allows retry after ten seconds and protects a late stop", async () => {
  const props = setup();
  await using screen = await render(<ComposerPrimaryActions {...props} />);
  using _timers = fakeTimers();
  await act(() =>
    (
      screen.getByRole("button", { name: "Stop generation" }).element() as HTMLButtonElement
    ).click(),
  );
  await act(() => vi.advanceTimersByTime(9_999));
  expect(screen.getByRole("button", { name: "Stopping", exact: true }).element()).toBeDisabled();
  await act(() => vi.advanceTimersByTime(1));
  await act(() =>
    (
      screen.getByRole("button", { name: "Stop generation" }).element() as HTMLButtonElement
    ).click(),
  );
  await screen.rerender(
    <ComposerPrimaryActions {...props} isRunning={false} canInterrupt={false} canResume />,
  );
  await act(() =>
    (screen.getByRole("button", { name: "Resume thread" }).element() as HTMLButtonElement).click(),
  );
  expect(props.onInterrupt).toHaveBeenCalledTimes(2);
  expect(props.onResume).not.toHaveBeenCalled();
});

it("keeps Stop pending across a permission failure", async () => {
  const props = setup();
  await using screen = await render(<ComposerPrimaryActions {...props} />);
  await act(() =>
    (
      screen.getByRole("button", { name: "Stop generation" }).element() as HTMLButtonElement
    ).click(),
  );
  await screen.rerender(
    <ComposerPrimaryActions {...props} canOperateThread={false} canInterrupt={false} />,
  );
  await screen.rerender(<ComposerPrimaryActions {...props} />);
  await expect
    .element(screen.getByRole("button", { name: "Stopping", exact: true }))
    .toBeDisabled();
  expect(props.onInterrupt).toHaveBeenCalledTimes(1);
});

it("keeps a pending stop when the run id clears and resets it for a different run", async () => {
  const props = setup();
  await using screen = await render(<ComposerPrimaryActions {...props} runId="first" />);
  await act(() =>
    (
      screen.getByRole("button", { name: "Stop generation" }).element() as HTMLButtonElement
    ).click(),
  );
  await screen.rerender(<ComposerPrimaryActions {...props} runId={null} />);
  expect(screen.getByRole("button", { name: "Stopping", exact: true }).element()).toBeDisabled();
  await screen.rerender(<ComposerPrimaryActions {...props} runId="second" />);
  expect(screen.getByRole("button", { name: "Stop generation" }).element()).toBeEnabled();
});

it("swaps the collapsed composer's send button for Stop while a turn can be stopped", async () => {
  const onInterrupt = vi.fn();
  const collapsed = (overrides: { canInterrupt?: boolean; hasSendableContent?: boolean } = {}) => (
    <CollapsedComposerStopAction
      canOperateThread
      canInterrupt={overrides.canInterrupt ?? true}
      runId="run"
      hasSendableContent={overrides.hasSendableContent ?? false}
      isEditingQueuedMessage={false}
      onInterrupt={onInterrupt}
    >
      <button type="button">Send message</button>
    </CollapsedComposerStopAction>
  );
  await using screen = await render(collapsed({ hasSendableContent: true }));
  await expect.element(screen.getByRole("button", { name: "Send message" })).toBeVisible();
  await screen.rerender(collapsed());
  await act(() =>
    (
      screen.getByRole("button", { name: "Stop generation" }).element() as HTMLButtonElement
    ).click(),
  );
  expect(onInterrupt).toHaveBeenCalledTimes(1);
  await expect
    .element(screen.getByRole("button", { name: "Stopping", exact: true }))
    .toBeDisabled();
  await screen.rerender(collapsed({ canInterrupt: false }));
  await expect.element(screen.getByRole("button", { name: "Send message" })).toBeVisible();
});

it("browses to the next question from the primary action while the current one is unanswered", async () => {
  const props = setup();
  const onNextPendingQuestion = vi.fn();
  const submit = vi.fn();
  await using screen = await render(
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <ComposerPrimaryActions
        {...props}
        pendingAction={{
          questionIndex: 0,
          questionCount: 2,
          isLastQuestion: false,
          canAdvance: false,
          isResponding: false,
          isComplete: false,
          answeredQuestionCount: 0,
          firstUnansweredQuestionIndex: 0,
        }}
        onNextPendingQuestion={onNextPendingQuestion}
      />
    </form>,
  );
  const next = screen.getByRole("button", { name: "Next", exact: true });
  await expect.element(next).toBeEnabled();
  await act(() => (next.element() as HTMLButtonElement).click());
  expect(onNextPendingQuestion).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();
});

it("points the last question's primary action at the first unanswered question", async () => {
  const props = setup();
  const onSelectPendingQuestionIndex = vi.fn();
  const submit = vi.fn();
  const pendingAction = {
    questionIndex: 2,
    questionCount: 3,
    isLastQuestion: true,
    canAdvance: true,
    isResponding: false,
    isComplete: false,
    answeredQuestionCount: 2,
    firstUnansweredQuestionIndex: 0,
  };
  const view = (compact: boolean) => (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <ComposerPrimaryActions
        {...props}
        compact={compact}
        pendingAction={pendingAction}
        onSelectPendingQuestionIndex={onSelectPendingQuestionIndex}
      />
    </form>
  );
  await using screen = await render(view(false));
  const fullLabel = screen.getByRole("button", { name: "Go to question 1", exact: true });
  await expect.element(fullLabel).toBeEnabled();
  await act(() => (fullLabel.element() as HTMLButtonElement).click());
  expect(onSelectPendingQuestionIndex).toHaveBeenCalledWith(0);
  expect(submit).not.toHaveBeenCalled();
  await screen.rerender(view(true));
  const compactLabel = screen.getByRole("button", { name: "Q1", exact: true });
  await expect.element(compactLabel).toBeEnabled();
  await act(() => (compactLabel.element() as HTMLButtonElement).click());
  expect(onSelectPendingQuestionIndex).toHaveBeenCalledTimes(2);
  expect(submit).not.toHaveBeenCalled();
});

it("keeps the last question's submit disabled when only that question is unanswered", async () => {
  const props = setup();
  await using screen = await render(
    <ComposerPrimaryActions
      {...props}
      compact={false}
      pendingAction={{
        questionIndex: 2,
        questionCount: 3,
        isLastQuestion: true,
        canAdvance: false,
        isResponding: false,
        isComplete: false,
        answeredQuestionCount: 2,
        firstUnansweredQuestionIndex: 2,
      }}
      onSelectPendingQuestionIndex={vi.fn()}
    />,
  );
  await expect
    .element(screen.getByRole("button", { name: "Submit answers", exact: true }))
    .toBeDisabled();
});

it("hides the Previous button in all-questions view", async () => {
  const props = setup();
  await using screen = await render(
    <ComposerPrimaryActions
      {...props}
      compact={false}
      pendingAction={{
        questionIndex: 1,
        questionCount: 3,
        isLastQuestion: false,
        allQuestionsView: true,
        canAdvance: false,
        isResponding: false,
        isComplete: false,
        answeredQuestionCount: 0,
        firstUnansweredQuestionIndex: 0,
      }}
      onSelectPendingQuestionIndex={vi.fn()}
    />,
  );
  expect(screen.getByRole("button", { name: "Previous", exact: true }).query()).toBeNull();
});

it("submits every answer directly from all-questions view", async () => {
  const props = setup();
  const onSubmitPendingAnswers = vi.fn();
  const submit = vi.fn();
  await using screen = await render(
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <ComposerPrimaryActions
        {...props}
        compact={false}
        pendingAction={{
          questionIndex: 0,
          questionCount: 3,
          isLastQuestion: false,
          allQuestionsView: true,
          canAdvance: false,
          isResponding: false,
          isComplete: true,
          answeredQuestionCount: 3,
          firstUnansweredQuestionIndex: null,
        }}
        onSubmitPendingAnswers={onSubmitPendingAnswers}
      />
    </form>,
  );
  const action = screen.getByRole("button", { name: "Submit answers", exact: true });
  await expect.element(action).toBeEnabled();
  await act(() => (action.element() as HTMLButtonElement).click());
  expect(onSubmitPendingAnswers).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();
});

it("points the all-questions action at the first unanswered question", async () => {
  const props = setup();
  const onSelectPendingQuestionIndex = vi.fn();
  const onSubmitPendingAnswers = vi.fn();
  const submit = vi.fn();
  await using screen = await render(
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <ComposerPrimaryActions
        {...props}
        compact={false}
        pendingAction={{
          questionIndex: 0,
          questionCount: 3,
          isLastQuestion: false,
          allQuestionsView: true,
          canAdvance: false,
          isResponding: false,
          isComplete: false,
          answeredQuestionCount: 2,
          firstUnansweredQuestionIndex: 2,
        }}
        onSelectPendingQuestionIndex={onSelectPendingQuestionIndex}
        onSubmitPendingAnswers={onSubmitPendingAnswers}
      />
    </form>,
  );
  const jump = screen.getByRole("button", { name: "Go to question 3", exact: true });
  await expect.element(jump).toBeEnabled();
  await act(() => (jump.element() as HTMLButtonElement).click());
  expect(onSelectPendingQuestionIndex).toHaveBeenCalledWith(2);
  expect(onSubmitPendingAnswers).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});

it("keeps the all-questions submit disabled while the current question is unanswered", async () => {
  const props = setup();
  await using screen = await render(
    <ComposerPrimaryActions
      {...props}
      compact={false}
      pendingAction={{
        questionIndex: 0,
        questionCount: 3,
        isLastQuestion: false,
        allQuestionsView: true,
        canAdvance: false,
        isResponding: false,
        isComplete: false,
        answeredQuestionCount: 2,
        firstUnansweredQuestionIndex: 0,
      }}
      onSelectPendingQuestionIndex={vi.fn()}
      onSubmitPendingAnswers={vi.fn()}
    />,
  );
  await expect
    .element(screen.getByRole("button", { name: "Submit answers", exact: true }))
    .toBeDisabled();
});
