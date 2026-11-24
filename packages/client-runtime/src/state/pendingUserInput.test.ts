import { describe, expect, it } from "vite-plus/test";

import {
  buildPendingUserInputAnswers,
  isPendingUserInputOptionSelected,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./pendingUserInput.ts";

const singleSelectQuestion = {
  id: "scope",
  header: "Scope",
  question: "What should the plan target first?",
  options: [
    { label: "Orchestration-first", description: "Focus on orchestration first" },
    { label: "Node.js", description: "Reuse TypeScript" },
  ],
  multiSelect: false,
} as const;

const nativeChoiceQuestion = {
  id: "result",
  header: "Result",
  question: "Which result should be used?",
  options: [
    { value: " first\t", label: "Result", description: "First result" },
    { value: "second", label: "Result", description: "Second result" },
  ],
  allowCustomAnswer: false,
  multiSelect: false,
} as const;

describe("resolvePendingUserInputAnswer", () => {
  it("preserves exact editor text, including a deliberately cleared answer", () => {
    const question = { ...singleSelectQuestion, initialAnswer: "  Proposed message\n" };
    expect(resolvePendingUserInputAnswer(question, { customAnswer: question.initialAnswer })).toBe(
      question.initialAnswer,
    );
    expect(resolvePendingUserInputAnswer(question, { customAnswer: "  Edited message\n\n" })).toBe(
      "  Edited message\n\n",
    );
    expect(resolvePendingUserInputAnswer(question, { customAnswer: "" })).toBe("");
    expect(resolvePendingUserInputAnswer(question, { customAnswer: " \n" })).toBe(" \n");
    expect(
      setPendingUserInputCustomAnswer(
        question,
        { selectedOptionValues: ["Orchestration-first"] },
        "",
      ),
    ).toEqual({ customAnswer: "" });
  });

  it("combines a selected option with a supplementary custom note", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionValues: ["Orchestration-first"],
        customAnswer: "Keep the existing envelope for one release",
      }),
    ).toBe("Orchestration-first\n\nKeep the existing envelope for one release");
  });

  it("submits a custom note on its own when no option is selected", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        customAnswer: "Keep the existing envelope for one release",
      }),
    ).toBe("Keep the existing envelope for one release");
  });

  it("appends a custom note to every multi-select option", () => {
    expect(
      resolvePendingUserInputAnswer(
        {
          ...singleSelectQuestion,
          multiSelect: true,
          options: [{ label: "Server" }, { label: "Web" }],
        },
        {
          selectedOptionValues: ["Server", "Web"],
          customAnswer: "Also mobile",
        },
      ),
    ).toEqual(["Server", "Web", "Also mobile"]);
  });

  it("does not replace a required choice with a custom answer", () => {
    expect(
      resolvePendingUserInputAnswer(nativeChoiceQuestion, {
        selectedOptionValues: ["second"],
        customAnswer: "Use another result",
      }),
    ).toBe("second");
  });

  it("does not submit labels or unknown values when an option has a value", () => {
    expect(
      resolvePendingUserInputAnswer(nativeChoiceQuestion, {
        selectedOptionValues: ["Result", "unknown"],
      }),
    ).toBeNull();
  });

  it("matches a label only for an option without a value", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, { selectedOptionValues: [" Node.js "] }),
    ).toBe("Node.js");
  });

  it("lets an optional text question stay blank", () => {
    const textQuestion = { id: "notes", options: [] };
    expect(resolvePendingUserInputAnswer({ ...textQuestion, required: false }, undefined)).toBe("");
    expect(
      resolvePendingUserInputAnswer({ ...textQuestion, required: false }, { customAnswer: " " }),
    ).toBe("");
    expect(resolvePendingUserInputAnswer(textQuestion, { customAnswer: " " })).toBeNull();
    expect(
      resolvePendingUserInputAnswer({ ...textQuestion, required: true }, { customAnswer: "" }),
    ).toBeNull();
  });

  it("accepts ready attachment-only answers while preserving selected options", () => {
    expect(resolvePendingUserInputAnswer(singleSelectQuestion, { attachmentCount: 1 })).toBe("");
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        attachmentCount: 1,
        selectedOptionValues: ["Node.js"],
      }),
    ).toBe("Node.js");
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        attachmentCount: 1,
        attachmentsBlocked: true,
      }),
    ).toBeNull();
    expect(
      resolvePendingUserInputAnswer(
        { ...singleSelectQuestion, allowCustomAnswer: false },
        { attachmentCount: 1 },
      ),
    ).toBeNull();
  });
});

describe("togglePendingUserInputOptionSelection", () => {
  it("selects and removes options with the same label independently", () => {
    const question = { ...nativeChoiceQuestion, multiSelect: true };
    const firstSelected = togglePendingUserInputOptionSelection(question, undefined, " first\t");
    const bothSelected = togglePendingUserInputOptionSelection(question, firstSelected, "second");

    expect(buildPendingUserInputAnswers([question], { result: bothSelected })).toEqual({
      result: [" first\t", "second"],
    });

    const secondSelected = togglePendingUserInputOptionSelection(
      question,
      bothSelected,
      " first\t",
    );
    expect(buildPendingUserInputAnswers([question], { result: secondSelected })).toEqual({
      result: ["second"],
    });
  });

  it("submits raw option values and leaves the draft alone for an unknown option", () => {
    const first = togglePendingUserInputOptionSelection(
      nativeChoiceQuestion,
      undefined,
      " first\t",
    );
    expect(isPendingUserInputOptionSelected(nativeChoiceQuestion, first, " first\t")).toBe(true);
    expect(isPendingUserInputOptionSelected(nativeChoiceQuestion, first, "second")).toBe(false);
    expect(buildPendingUserInputAnswers([nativeChoiceQuestion], { result: first })).toEqual({
      result: " first\t",
    });
    expect(togglePendingUserInputOptionSelection(nativeChoiceQuestion, first, "Result")).toBe(
      first,
    );
  });

  it("keeps a custom note when the user selects and clears options", () => {
    const question = {
      ...singleSelectQuestion,
      options: [{ label: "Incremental" }, { label: "Rewrite" }],
    };
    const withNote = { customAnswer: "first try" };
    const selected = togglePendingUserInputOptionSelection(question, withNote, "Incremental");
    expect(selected).toEqual({
      customAnswer: "first try",
      selectedOptionValues: ["Incremental"],
    });
    expect(isPendingUserInputOptionSelected(question, selected, "Incremental")).toBe(true);
    expect(togglePendingUserInputOptionSelection(question, selected, "Incremental")).toEqual({
      customAnswer: "first try",
    });

    const multiQuestion = { ...question, multiSelect: true };
    const multiSelected = togglePendingUserInputOptionSelection(
      multiQuestion,
      withNote,
      "Incremental",
    );
    expect(multiSelected).toEqual({
      customAnswer: "first try",
      selectedOptionValues: ["Incremental"],
    });
    expect(togglePendingUserInputOptionSelection(multiQuestion, multiSelected, "Rewrite")).toEqual({
      customAnswer: "first try",
      selectedOptionValues: ["Incremental", "Rewrite"],
    });
  });
});

describe("setPendingUserInputCustomAnswer", () => {
  it("rejects arbitrary text when the provider only accepts offered options", () => {
    expect(setPendingUserInputCustomAnswer(nativeChoiceQuestion, undefined, "Other")).toEqual({});
    expect(
      buildPendingUserInputAnswers([nativeChoiceQuestion], { result: { customAnswer: "Other" } }),
    ).toBeNull();
    expect(
      buildPendingUserInputAnswers([nativeChoiceQuestion], {
        result: { selectedOptionValues: ["second"], customAnswer: "stale draft" },
      }),
    ).toEqual({ result: "second" });
  });

  it("keeps selected options alongside a note and clears them for an initial answer", () => {
    expect(
      setPendingUserInputCustomAnswer(
        singleSelectQuestion,
        { selectedOptionValues: ["Orchestration-first"] },
        "Keep the existing envelope for one release",
      ),
    ).toEqual({
      customAnswer: "Keep the existing envelope for one release",
      selectedOptionValues: ["Orchestration-first"],
    });

    const initialAnswerQuestion = { ...singleSelectQuestion, initialAnswer: "Proposed message" };
    expect(
      setPendingUserInputCustomAnswer(
        initialAnswerQuestion,
        { selectedOptionValues: ["Orchestration-first"] },
        "Edited message",
      ),
    ).toEqual({ customAnswer: "Edited message" });
  });
});

const compatQuestion = {
  id: "compat",
  header: "Compat",
  question: "How strict should compatibility be?",
  options: [{ label: "Keep current envelope", description: "Preserve current wire format" }],
  multiSelect: false,
} as const;

describe("buildPendingUserInputAnswers", () => {
  it("returns a canonical answer map for complete prompts", () => {
    expect(
      buildPendingUserInputAnswers([singleSelectQuestion, compatQuestion], {
        scope: { selectedOptionValues: ["Orchestration-first"] },
        compat: { customAnswer: "Keep the current envelope for one release window" },
      }),
    ).toEqual({
      scope: "Orchestration-first",
      compat: "Keep the current envelope for one release window",
    });
  });
});

it.each([
  ["single-select", singleSelectQuestion, ["Orchestration-first"], '"Orchestration-first"'],
  [
    "multi-select",
    {
      ...singleSelectQuestion,
      multiSelect: true,
      options: [{ label: "Server" }, { label: "Web" }],
    },
    ["Server", "Web"],
    '["Server","Web"]',
  ],
])("sends a %s answer to a question with the id __proto__", (_kind, question, selected, json) => {
  const answers = buildPendingUserInputAnswers(
    [
      { ...question, id: "__proto__" },
      { ...singleSelectQuestion, id: "name" },
    ],
    {
      ["__proto__"]: { selectedOptionValues: selected },
      name: { selectedOptionValues: ["Orchestration-first"] },
    },
  );

  expect(JSON.stringify(answers)).toBe(`{"__proto__":${json},"name":"Orchestration-first"}`);
});
