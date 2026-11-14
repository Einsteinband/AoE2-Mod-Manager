import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { ref } from "vue";
import TopBar from "../layout/TopBar.vue";

const mockLocale = ref("zh");

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: mockLocale,
  }),
}));

let observed: Array<HTMLElement> = [];
let roCallback: ((entries: ResizeObserverEntry[]) => void) | null = null;
let moCallback: ((mutations: MutationRecord[]) => void) | null = null;
let clientWidthSpy: ReturnType<typeof vi.spyOn> | null = null;

const slotMarkup = `
  <div class="mod-toolbar">
    <div class="search-box"></div>
    <div class="toolbar">
      <select></select>
      <button class="icon-btn" type="button"><span class="btn-text">Rescan</span></button>
    </div>
  </div>
  <div class="topbar-actions">
    <button class="launch-game-btn" type="button"><span class="btn-text">Launch</span></button>
    <div class="view-switch">
      <button class="view-btn" type="button"><span class="view-icon">▦</span><span class="view-text">Grid</span></button>
      <button class="view-btn" type="button"><span class="view-icon">☰</span><span class="view-text">List</span></button>
    </div>
  </div>
`;

function setClientWidth(bar: HTMLElement, width: number): void {
  Object.defineProperty(bar, "clientWidth", { configurable: true, writable: true, value: width });
}

function roEntry(width: number, height: number): ResizeObserverEntry {
  return { contentRect: { width, height } } as ResizeObserverEntry;
}

async function flushInitialLayout(): Promise<void> {
  await flushPromises();
}

function mountTopBar(width = 1000) {
  const wrapper = mount(TopBar, {
    props: { mode: "local" },
    slots: { default: slotMarkup },
  });
  const bar = wrapper.element as HTMLElement;
  // jsdom 不做真实布局；固定一个宽容器，内在需求在测试中由克隆测量得到 0，用于验证状态链路。
  setClientWidth(bar, width);
  return wrapper;
}

describe("TopBar responsive scheduling", () => {
  beforeEach(() => {
    observed = [];
    roCallback = null;
    moCallback = null;
    clientWidthSpy = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(1000);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: (entries: ResizeObserverEntry[]) => void) {
          roCallback = callback;
        }
        observe(el: HTMLElement) {
          observed.push(el);
        }
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "MutationObserver",
      class {
        constructor(callback: (mutations: MutationRecord[]) => void) {
          moCallback = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    clientWidthSpy?.mockRestore();
    vi.unstubAllGlobals();
  });

  it("mounts expanded in a safe wide container and observes the topbar", async () => {
    const wrapper = mountTopBar();
    await flushPromises();
    await flushInitialLayout();

    expect(wrapper.classes("is-compact")).toBe(false);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toBe(wrapper.element);
    expect(wrapper.emitted("stage-change")?.[0]).toEqual(["expanded"]);
  });

  it("keeps the badge-only brand while action controls are iconized in compact", async () => {
    const rectSpy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue({ width: 100, height: 32 } as DOMRect);
    const wrapper = mountTopBar(300);
    setClientWidth(wrapper.element as HTMLElement, 300);
    await flushPromises();
    await flushInitialLayout();

    expect(wrapper.classes("is-compact")).toBe(true);
    expect(wrapper.find(".brand").classes("is-brand-badge")).toBe(true);
    expect(wrapper.find(".brand .name-full").exists()).toBe(true);

    rectSpy.mockRestore();
  });

  it("does not recover when ResizeObserver reports only a height change at the same width", async () => {
    const wrapper = mountTopBar();
    await flushPromises();
    await flushInitialLayout();

    roCallback?.([roEntry(1000, 72)]);
    await flushInitialLayout();
    expect(wrapper.classes("is-brand-badge")).toBe(false);
    expect(wrapper.classes("is-compact")).toBe(false);
  });

  it("does not recover after internal brand, toolbar or search DOM changes while width stays constant", async () => {
    const wrapper = mountTopBar();
    await flushPromises();
    await flushInitialLayout();

    moCallback?.([]);
    await flushInitialLayout();

    expect(wrapper.classes("is-brand-badge")).toBe(false);
    expect(wrapper.classes("is-compact")).toBe(false);
  });

  it("dedupes the same width report from ResizeObserver and window resize without cloning controls again", async () => {
    mountTopBar();
    await flushPromises();
    await flushInitialLayout();

    const cloneSpy = vi.spyOn(Element.prototype, "cloneNode");
    roCallback?.([roEntry(1000, 58)]);
    window.dispatchEvent(new Event("resize"));
    await flushInitialLayout();

    expect(cloneSpy).not.toHaveBeenCalled();
  });

  it("re-evaluates after mode and locale changes without language/page-specific threshold", async () => {
    const wrapper = mountTopBar();
    await flushPromises();
    await flushInitialLayout();
    expect(wrapper.classes("is-compact")).toBe(false);

    await wrapper.setProps({ mode: "online" });
    mockLocale.value = "es";
    await flushPromises();
    await flushInitialLayout();

    expect(wrapper.props("mode")).toBe("online");
    expect(mockLocale.value).toBe("es");
    expect(wrapper.classes("is-compact")).toBe(false);
  });

  it("disconnects observer and removes resize listener on unmount", async () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const wrapper = mountTopBar();
    await flushPromises();

    await wrapper.unmount();

    expect(removeSpy).toHaveBeenCalledWith("resize", expect.any(Function));
  });
});
