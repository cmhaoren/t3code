import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import type { PendingUserInputDraftAnswer } from "@t3tools/client-runtime/state/pending-user-input";
import { type ReactNode, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { PendingUserInput } from "../../session-logic";
import { Select, SelectTrigger } from "../ui/select";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

const prompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("question-shortcuts"),
  createdAt: "2026-10-31T00:00:00.000Z",
  dismissible: false,
  responseCapability: "live",
  questions: [
    {
      id: "question",
      header: "Rollout",
      question: "How should this ship?",
      options: [{ label: "Incremental", description: "One module at a time" }],
      multiSelect: true,
    },
  ],
};

const multiPrompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("question-multi"),
  createdAt: "2026-10-31T00:00:00.000Z",
  dismissible: false,
  responseCapability: "live",
  questions: [
    {
      id: "question-0",
      header: "First",
      question: "Choose for the first question",
      options: [{ label: "Alpha", description: "The first option" }],
      multiSelect: false,
    },
    {
      id: "question-1",
      header: "Second",
      question: "Choose for the second question",
      options: [{ label: "Beta", description: "The second option" }],
      multiSelect: false,
    },
    {
      id: "question-2",
      header: "Third",
      question: "Choose for the third question",
      options: [{ label: "Gamma", description: "The third option" }],
      multiSelect: false,
    },
  ],
};

const VIEW_MODE_STORAGE_KEY = "t3code:pending-user-input:view-mode";
const HEIGHT_EXPANDED_STORAGE_KEY = "t3code:pending-user-input:height-expanded";

/** Clears the panel's saved preferences before each test and again when it ends. */
function cleanPendingUserInputPreferences(): Disposable {
  const clear = () => {
    window.localStorage.removeItem(VIEW_MODE_STORAGE_KEY);
    window.localStorage.removeItem(HEIGHT_EXPANDED_STORAGE_KEY);
  };
  clear();
  return { [Symbol.dispose]: clear };
}

function NavigablePanel({
  answers: initialAnswers = {},
  onToggleOption,
  onAdvance,
}: {
  answers?: Record<string, PendingUserInputDraftAnswer>;
  onToggleOption?: (questionId: string, optionValue: string) => void;
  onAdvance?: () => void;
}) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState(initialAnswers);
  const toggleOption = (questionId: string, optionValue: string) => {
    onToggleOption?.(questionId, optionValue);
    const question = multiPrompt.questions.find((candidate) => candidate.id === questionId);
    if (!question) return;
    setAnswers((current) => ({
      ...current,
      [questionId]: {
        selectedOptionValues: question.multiSelect
          ? [...(current[questionId]?.selectedOptionValues ?? []), optionValue]
          : [optionValue],
      },
    }));
  };
  return (
    <ComposerPendingUserInputPanel
      pendingUserInputs={[multiPrompt]}
      cwd={undefined}
      threadRef={threadRef}
      respondingRequestIds={[]}
      answers={answers}
      questionIndex={questionIndex}
      onToggleOption={toggleOption}
      onAdvance={onAdvance ?? (() => {})}
      onDismiss={() => {}}
      onSelectQuestionIndex={setQuestionIndex}
    />
  );
}

it.each<{ focus: string; control: ReactNode; toggles: boolean }>([
  { focus: "a page button", control: <button type="button" aria-label="Focused" />, toggles: true },
  {
    focus: "a dialog",
    control: (
      <div role="dialog">
        <button type="button" aria-label="Focused" />
      </div>
    ),
    toggles: false,
  },
  {
    focus: "a popup",
    control: (
      <div data-slot="menu-popup">
        <button type="button" aria-label="Focused" />
      </div>
    ),
    toggles: false,
  },
  {
    focus: "a menu",
    control: (
      <div role="menu">
        <button type="button" role="menuitem" aria-label="Focused" />
      </div>
    ),
    toggles: false,
  },
  {
    focus: "a select",
    control: (
      <select aria-label="Focused">
        <option>One</option>
      </select>
    ),
    toggles: false,
  },
  {
    focus: "a closed select menu",
    control: (
      <Select>
        <SelectTrigger aria-label="Focused" />
      </Select>
    ),
    toggles: false,
  },
  {
    focus: "a device screen that takes the key",
    control: (
      <div
        role="application"
        aria-label="Focused"
        tabIndex={0}
        onKeyDown={(event) => event.preventDefault()}
      />
    ),
    toggles: false,
  },
])(
  "digit shortcut with focus in $focus toggles an option: $toggles",
  async ({ control, toggles }) => {
    const onToggleOption = vi.fn();
    await using screen = await render(
      <>
        {control}
        <ComposerPendingUserInputPanel
          pendingUserInputs={[prompt]}
          cwd={undefined}
          threadRef={threadRef}
          respondingRequestIds={[]}
          answers={{}}
          questionIndex={0}
          onToggleOption={onToggleOption}
          onAdvance={vi.fn()}
          onDismiss={vi.fn()}
        />
      </>,
    );
    await expect.element(screen.getByText("Incremental")).toBeVisible();
    screen.getByLabelText("Focused").element().focus();

    await userEvent.keyboard("1");

    expect(onToggleOption.mock.calls).toEqual(toggles ? [["question", "Incremental"]] : []);
  },
);

it("navigates linearly between questions with the header arrows and no stepper", async () => {
  using _preferences = cleanPendingUserInputPreferences();
  await using screen = await render(<NavigablePanel />);

  // The horizontal stepper is gone; navigation lives in the header row only.
  expect(screen.container.querySelector("[data-pending-user-input-stepper]")).toBeNull();
  expect(screen.container.querySelectorAll("[data-pending-question-tab]")).toHaveLength(0);

  const previous = screen.getByRole("button", { name: "Previous question" });
  const next = screen.getByRole("button", { name: "Next question" });
  expect(previous.element().hasAttribute("disabled")).toBe(true);
  expect(next.element().hasAttribute("disabled")).toBe(false);

  await next.click();
  await expect.element(screen.getByText("Choose for the second question")).toBeVisible();

  await next.click();
  await expect.element(screen.getByText("Choose for the third question")).toBeVisible();
  expect(next.element().hasAttribute("disabled")).toBe(true);

  await previous.click();
  await expect.element(screen.getByText("Choose for the second question")).toBeVisible();

  await previous.click();
  await expect.element(screen.getByText("Choose for the first question")).toBeVisible();

  // Answering keeps the single view on the question the user is reading.
  await screen.getByRole("button", { name: "Next question" }).click();
  await userEvent.click(screen.getByText("Beta"));
  await expect.element(screen.getByText("1/3 answered")).toBeVisible();
  await expect.element(screen.getByText("Choose for the second question")).toBeVisible();
});

it("shows every question at once, answers a card, and does not auto-advance", async () => {
  using _preferences = cleanPendingUserInputPreferences();
  const onToggleOption = vi.fn();
  const onAdvance = vi.fn();
  await using screen = await render(
    <NavigablePanel onToggleOption={onToggleOption} onAdvance={onAdvance} />,
  );

  await screen.getByTitle("View all questions together").click();

  expect(screen.container.querySelector("[data-pending-user-input-prev]")).toBeNull();
  expect(screen.container.querySelector("[data-pending-user-input-next]")).toBeNull();
  await expect.element(screen.getByText("All questions", { exact: true })).toBeVisible();

  const firstCard = screen.container.querySelector('[data-pending-question-card="0"]');
  const secondCard = screen.container.querySelector('[data-pending-question-card="1"]');
  expect(firstCard).not.toBeNull();
  expect(secondCard).not.toBeNull();
  expect(screen.container.querySelectorAll("[data-pending-question-card]")).toHaveLength(3);

  await userEvent.click(screen.getByText("Beta"));

  expect(onToggleOption.mock.calls).toEqual([["question-1", "Beta"]]);
  expect(
    screen.container
      .querySelector('[data-pending-question-card="1"]')
      ?.getAttribute("data-pending-question-active"),
  ).toBe("true");
  await expect.element(screen.getByText("1/3 answered")).toBeVisible();

  // "All" mode must not schedule the single-view auto-advance timer at all.
  const setTimeoutSpy = vi.spyOn(window, "setTimeout");
  try {
    await userEvent.click(screen.getByText("Gamma"));
    expect(setTimeoutSpy.mock.calls.some((call) => call[1] === 200)).toBe(false);
  } finally {
    setTimeoutSpy.mockRestore();
  }
  expect(onAdvance).not.toHaveBeenCalled();

  // The height preference works in all-questions view too.
  const heightToggle = () =>
    screen.container.querySelector<HTMLElement>("[data-pending-user-input-height]");
  expect(heightToggle()?.getAttribute("data-pending-user-input-height")).toBe("default");
  await screen.getByTitle("Expand question panel height").click();
  expect(heightToggle()?.getAttribute("data-pending-user-input-height")).toBe("expanded");
});

it("unwraps a provider's generic elicitation question into a numbered header", async () => {
  using _preferences = cleanPendingUserInputPreferences();
  const genericPrompt: PendingUserInput = {
    requestId: RuntimeRequestId.make("question-generic"),
    createdAt: "2026-10-31T00:00:00.000Z",
    dismissible: false,
    responseCapability: "live",
    questions: [
      {
        id: "generic-0",
        header: "How should this ship?",
        question: "The agent has 2 questions.",
        options: [{ label: "Incremental", description: "One module at a time" }],
        multiSelect: false,
      },
      {
        id: "generic-1",
        header: "Which module goes first?",
        question: "The agent has 2 questions.",
        options: [{ label: "Auth", description: "Sign-in first" }],
        multiSelect: false,
      },
    ],
  };
  await using screen = await render(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[genericPrompt]}
      cwd={undefined}
      threadRef={threadRef}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      onToggleOption={vi.fn()}
      onAdvance={vi.fn()}
      onDismiss={vi.fn()}
      onSelectQuestionIndex={vi.fn()}
    />,
  );

  // The header is numbered and the real question moves into the body, untruncated.
  await expect.element(screen.getByText("Question 1", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("How should this ship?", { exact: true })).toBeVisible();
  expect(screen.container.textContent).not.toContain("The agent has 2 questions.");
});

it("renders a (Recommended) marker as a badge without changing the option value", async () => {
  using _preferences = cleanPendingUserInputPreferences();
  const onToggleOption = vi.fn();
  const recommendedPrompt: PendingUserInput = {
    requestId: RuntimeRequestId.make("question-recommended"),
    createdAt: "2026-10-31T00:00:00.000Z",
    dismissible: false,
    responseCapability: "live",
    questions: [
      {
        id: "recommended-question",
        header: "Release",
        question: "Which channel should this ship on?",
        options: [
          {
            label: "(Recommended) Stable",
            description: "Stable (Recommended)",
            value: "stable-channel",
          },
          { label: "Beta (Recommended)", description: "Beta (Recommended)" },
        ],
        multiSelect: false,
      },
    ],
  };
  await using screen = await render(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[recommendedPrompt]}
      cwd={undefined}
      threadRef={threadRef}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      onToggleOption={onToggleOption}
      onAdvance={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );

  await expect.element(screen.getByText("Stable", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Beta", { exact: true })).toBeVisible();
  expect(
    Array.from(screen.container.querySelectorAll("span")).filter(
      (element) => element.textContent === "Recommended",
    ),
  ).toHaveLength(2);
  // The marker never reaches the rendered text, even when a description repeats the label.
  expect(screen.container.textContent).not.toContain("(Recommended)");

  await userEvent.click(screen.getByText("Stable", { exact: true }));
  await userEvent.click(screen.getByText("Beta", { exact: true }));

  expect(onToggleOption.mock.calls).toEqual([
    ["recommended-question", "stable-channel"],
    ["recommended-question", "Beta (Recommended)"],
  ]);
});

it("expands the panel height and remembers it across a remount", async () => {
  using _preferences = cleanPendingUserInputPreferences();
  await using screen = await render(<NavigablePanel />);

  const heightToggle = () =>
    screen.container.querySelector<HTMLElement>("[data-pending-user-input-height]");
  expect(heightToggle()?.getAttribute("data-pending-user-input-height")).toBe("default");

  await screen.getByTitle("Expand question panel height").click();
  expect(heightToggle()?.getAttribute("data-pending-user-input-height")).toBe("expanded");
  expect(window.localStorage.getItem(HEIGHT_EXPANDED_STORAGE_KEY)).toBe("true");

  await screen.rerender(null);
  await screen.rerender(<NavigablePanel />);
  expect(heightToggle()?.getAttribute("data-pending-user-input-height")).toBe("expanded");
  await expect.element(screen.getByTitle("Restore question panel height")).toBeVisible();
});
