import { describe, it, expect } from "vitest";
import { useContextMenu } from "../useContextMenu";

interface FakeMod {
  id: number;
}

describe("useContextMenu", () => {
  it("stores the right-click snapshot and coordinates; close clears both", () => {
    const menu = useContextMenu<FakeMod>();
    const target: FakeMod = { id: 7 };
    const mouse = new MouseEvent("contextmenu", { clientX: 120, clientY: 80 });

    menu.openAt(mouse, target);

    expect(menu.open.value).toBe(true);
    expect(menu.x.value).toBe(120);
    expect(menu.y.value).toBe(80);
    expect(menu.target.value).toBe(target);

    menu.close();
    expect(menu.open.value).toBe(false);
    expect(menu.target.value).toBeNull();
  });

  it("positions keyboard-open from trigger element rect when available", () => {
    const menu = useContextMenu<FakeMod>();
    const target: FakeMod = { id: 9 };
    const el = document.createElement("div");
    el.getBoundingClientRect = () => ({
      left: 30,
      bottom: 200,
      top: 170,
      right: 130,
      width: 100,
      height: 30,
      x: 30,
      y: 170,
      toJSON: () => ({}),
    });
    const key = new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true });
    Object.defineProperty(key, "currentTarget", { value: el });

    menu.openAt(key, target);
    expect(menu.x.value).toBe(30);
    expect(menu.y.value).toBe(200);
    expect(menu.target.value).toBe(target);
  });

  it("openAtPoint clamps negative coordinates to zero", () => {
    const menu = useContextMenu<FakeMod>();
    menu.openAtPoint(-12, -5, { id: 1 });
    expect(menu.x.value).toBe(0);
    expect(menu.y.value).toBe(0);
  });
});
