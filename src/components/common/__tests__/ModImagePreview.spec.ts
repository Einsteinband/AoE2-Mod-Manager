import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import ModImagePreview from "../ModImagePreview.vue";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

function mountPreview() {
  return mount(ModImagePreview, {
    props: { url: "asset://localhost/cover.png" },
  });
}

function pointerEvent(type: string, clientX = 0, clientY = 0, button = 0) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { value: clientX });
  Object.defineProperty(event, "clientY", { value: clientY });
  Object.defineProperty(event, "button", { value: button });
  return event;
}

function parseTransform(wrapper: ReturnType<typeof mountPreview>) {
  const style = wrapper.find("img").attributes("style") ?? "";
  const scale = Number(style.match(/scale\(([^)]+)\)/)?.[1] ?? 1);
  const translate = style.match(/translate3d\(([-\d.]+)px, ([-\d.]+)px, (?:0|0px)\)/);
  return {
    scale,
    x: Number(translate?.[1] ?? 0),
    y: Number(translate?.[2] ?? 0),
  };
}

describe("ModImagePreview", () => {
  it("renders the current cached URL, close control and interaction hint", () => {
    const wrapper = mountPreview();

    const img = wrapper.find("img");
    expect(img.exists()).toBe(true);
    expect(img.attributes("src")).toBe("asset://localhost/cover.png");
    expect(wrapper.find('[aria-label="detail.imagePreviewClose"]').exists()).toBe(true);
    expect(wrapper.find(".image-preview-hint").text()).toBe("detail.imagePreviewHint");
  });

  it("closes with Escape", async () => {
    const wrapper = mountPreview();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("closes from the backdrop and close button, but not from clicking the image", async () => {
    const wrapper = mountPreview();

    await wrapper.find("img").trigger("click");
    expect(wrapper.emitted("close")).toBeFalsy();

    await wrapper.find(".image-preview-close").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);

    await wrapper.unmount();
    const backdropWrapper = mountPreview();
    await backdropWrapper.find(".image-preview").trigger("click");
    expect(backdropWrapper.emitted("close")).toHaveLength(1);
  });

  it("zooms around clamped limits without exceeding 0.5x or 5x", async () => {
    const wrapper = mountPreview();

    for (let i = 0; i < 30; i += 1) {
      await wrapper.find("img").trigger("wheel", { deltaY: -120 });
    }
    let position = parseTransform(wrapper);
    expect(position.scale).toBeCloseTo(5, 10);
    expect(position.x).toBeCloseTo(0, 10);
    expect(position.y).toBeCloseTo(0, 10);

    for (let i = 0; i < 30; i += 1) {
      await wrapper.find("img").trigger("wheel", { deltaY: 120 });
    }
    position = parseTransform(wrapper);
    expect(position.scale).toBeCloseTo(0.5, 10);
    expect(position.x).toBeCloseTo(0, 10);
    expect(position.y).toBeCloseTo(0, 10);
  });

  it("keeps the preview center fixed when zooming after a drag", async () => {
    const wrapper = mountPreview();
    const img = wrapper.find("img");

    img.element.dispatchEvent(pointerEvent("pointerdown", 10, 10, 0));
    window.dispatchEvent(pointerEvent("pointermove", 28, 25));
    window.dispatchEvent(pointerEvent("pointerup"));
    await wrapper.vm.$nextTick();

    await img.trigger("wheel", { deltaY: -120 });

    const position = parseTransform(wrapper);
    expect(position.scale).toBeCloseTo(1.16, 10);
    expect(position.x).toBeCloseTo(18 * 1.16, 10);
    expect(position.y).toBeCloseTo(15 * 1.16, 10);
  });

  it("drags the image with the left button and stops after pointer release", async () => {
    const wrapper = mountPreview();
    const img = wrapper.find("img");

    img.element.dispatchEvent(pointerEvent("pointerdown", 10, 10, 0));
    window.dispatchEvent(pointerEvent("pointermove", 32, 25));
    await wrapper.vm.$nextTick();

    let position = parseTransform(wrapper);
    expect(position.x).toBe(22);
    expect(position.y).toBe(15);

    window.dispatchEvent(pointerEvent("pointerup"));
    window.dispatchEvent(pointerEvent("pointermove", 60, 80));
    await wrapper.vm.$nextTick();

    position = parseTransform(wrapper);
    expect(position.x).toBe(22);
    expect(position.y).toBe(15);
  });

  it("starts from the default fit scale and position when reopened", async () => {
    const first = mountPreview();
    const firstImage = first.find("img");
    await firstImage.trigger("wheel", { deltaY: -120 });
    firstImage.element.dispatchEvent(pointerEvent("pointerdown", 0, 0, 0));
    window.dispatchEvent(pointerEvent("pointermove", 18, 9));
    window.dispatchEvent(pointerEvent("pointerup"));
    first.unmount();

    const reopened = mountPreview();
    const position = parseTransform(reopened);
    expect(position.scale).toBeCloseTo(1, 10);
    expect(position.x).toBe(0);
    expect(position.y).toBe(0);
  });
});
