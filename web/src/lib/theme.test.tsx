import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useResolvedMode, useTheme } from "./theme";

function Shown(): ReactNode {
  return <p>{useResolvedMode()}</p>;
}

function Switch(): ReactNode {
  const [, setTheme] = useTheme();
  return (
    <button
      type="button"
      onClick={() => {
        setTheme("dark");
      }}
    >
      Choose dark
    </button>
  );
}

describe("the resolved mode (OP-150)", () => {
  it("follows a choice made elsewhere at once", () => {
    render(
      <>
        <Shown />
        <Switch />
      </>,
    );
    expect(screen.getByText("light")).toBeInTheDocument();
    act(() => {
      screen.getByRole("button", { name: "Choose dark" }).click();
    });
    expect(screen.getByText("dark")).toBeInTheDocument();
    expect(document.documentElement.dataset["theme"]).toBe("dark");
  });
});
