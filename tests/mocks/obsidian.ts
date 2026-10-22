// Minimal runtime mock of the "obsidian" package for vitest (aliased in vitest.config.mjs).
// Shared by all tests: do not change behavior here for one test; use vi.mock or
// vi.spyOn in the test file instead.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { parse, stringify } from "yaml";

export function parseYaml(text: string): unknown {
  return parse(text);
}

export function stringifyYaml(obj: unknown): string {
  return stringify(obj);
}

export function createMockElement(tag = "div", opts: any = {}): any {
  const children: any[] = [];
  const classes = new Set<string>(
    typeof opts.cls === "string"
      ? opts.cls.split(/\s+/).filter(Boolean)
      : Array.isArray(opts.cls)
        ? opts.cls
        : [],
  );
  const attrs: Record<string, string> = { ...(opts.attr ?? {}) };
  const listeners = new Map<string, Array<(...args: any[]) => any>>();
  const el: any = {
    tagName: tag.toUpperCase(),
    textContent: opts.text ?? "",
    value: opts.value ?? "",
    children,
    dataset: {},
    style: {},
    attrs,
    classList: {
      add: (...c: string[]) => c.forEach((x) => classes.add(x)),
      remove: (...c: string[]) => c.forEach((x) => classes.delete(x)),
      contains: (c: string) => classes.has(c),
      toggle: (c: string, force?: boolean) => {
        const shouldAdd = force ?? !classes.has(c);
        if (shouldAdd) classes.add(c);
        else classes.delete(c);
        return shouldAdd;
      },
    },
    empty() {
      children.length = 0;
      el.textContent = "";
    },
    addClass(...c: string[]) {
      c.forEach((x) => classes.add(x));
    },
    removeClass(...c: string[]) {
      c.forEach((x) => classes.delete(x));
    },
    hasClass(c: string) {
      return classes.has(c);
    },
    setAttribute(k: string, v: string) {
      attrs[k] = v;
    },
    getAttribute(k: string) {
      return attrs[k] ?? null;
    },
    setText(text: string) {
      el.textContent = text;
    },
    appendText(text: string) {
      el.textContent += text;
    },
    setAttr(k: string, v: any) {
      if (v === null || v === undefined) delete attrs[k];
      else attrs[k] = String(v);
    },
    getAttr(k: string) {
      return attrs[k] ?? null;
    },
    createEl(childTag: string, childOpts?: any) {
      const child = createMockElement(childTag, childOpts);
      children.push(child);
      return child;
    },
    createDiv(childOpts?: any) {
      return el.createEl("div", childOpts);
    },
    createSpan(childOpts?: any) {
      return el.createEl("span", childOpts);
    },
    appendChild(child: any) {
      children.push(child);
      return child;
    },
    addEventListener(evt: string, cb: (...args: any[]) => any) {
      const list = listeners.get(evt) ?? [];
      list.push(cb);
      listeners.set(evt, list);
    },
    removeEventListener(evt: string, cb: (...args: any[]) => any) {
      const list = listeners.get(evt) ?? [];
      listeners.set(
        evt,
        list.filter((fn) => fn !== cb),
      );
    },
    dispatchEvent(evt: { type: string; [k: string]: any }) {
      for (const fn of listeners.get(evt.type) ?? []) fn(evt);
    },
  };
  return el;
}

export const requestUrlMock = {
  handler: async (_req: any): Promise<any> => {
    throw new Error("requestUrl not mocked in this test");
  },
};

/** Tests replace requestUrlMock.handler to answer requests. */
export function requestUrl(req: any): Promise<any> {
  return requestUrlMock.handler(typeof req === "string" ? { url: req } : req);
}

let language = "en";
export function setMockLanguage(lang: string): void {
  language = lang;
}
export function getLanguage(): string {
  return language;
}

export function setIcon(el: any, icon: string): void {
  if (el && typeof el === "object") el.dataset = { ...(el.dataset ?? {}), icon };
}

export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");
}

export function debounce<T extends unknown[]>(cb: (...args: T) => unknown, _timeout?: number) {
  const fn = (...args: T) => {
    cb(...args);
    return fn;
  };
  (fn as any).cancel = () => fn;
  (fn as any).run = () => undefined;
  return fn;
}

export const Platform = {
  isDesktop: true,
  isDesktopApp: true,
  isMobile: false,
  isMobileApp: false,
  isWin: process.platform === "win32",
  isMacOS: process.platform === "darwin",
  isLinux: process.platform === "linux",
};

export const notices: string[] = [];
export class Notice {
  message: string;
  noticeEl: any = createMockElement("div");
  containerEl: any = createMockElement("div");
  constructor(message: string | DocumentFragment, _timeout?: number) {
    this.message = typeof message === "string" ? message : "[fragment]";
    notices.push(this.message);
  }
  setMessage(message: string) {
    this.message = message;
    return this;
  }
  hide() {}
}

export class Events {
  private handlers = new Map<string, Array<(...args: any[]) => any>>();
  on(name: string, cb: (...args: any[]) => any) {
    const list = this.handlers.get(name) ?? [];
    list.push(cb);
    this.handlers.set(name, list);
    return { name, cb };
  }
  offref(ref: { name: string; cb: (...args: any[]) => any }) {
    const list = this.handlers.get(ref.name) ?? [];
    this.handlers.set(
      ref.name,
      list.filter((h) => h !== ref.cb),
    );
  }
  trigger(name: string, ...args: any[]) {
    for (const h of this.handlers.get(name) ?? []) h(...args);
  }
}

export class Component {
  load() {}
  onload() {}
  unload() {}
  onunload() {}
  register(_cb: () => any) {}
  registerEvent(_ref: any) {}
  registerDomEvent(..._args: any[]) {}
  registerInterval(id: number) {
    return id;
  }
  addChild<T>(c: T) {
    return c;
  }
}

export class Plugin extends Component {
  app: any;
  manifest: any;
  constructor(app: any, manifest: any) {
    super();
    this.app = app;
    this.manifest = manifest;
  }
  async loadData() {
    return null;
  }
  async saveData(_data: any) {}
  addSettingTab(_tab: any) {}
  addCommand(cmd: any) {
    return cmd;
  }
  addRibbonIcon(..._args: any[]) {
    return createMockElement("div");
  }
  registerView(..._args: any[]) {}
  registerMarkdownCodeBlockProcessor(..._args: any[]) {}
  addStatusBarItem() {
    return createMockElement("div");
  }
}

export class ItemView extends Component {
  app: any;
  leaf: any;
  containerEl: any = createMockElement("div");
  contentEl: any = createMockElement("div");
  constructor(leaf: any) {
    super();
    this.leaf = leaf;
    this.app = leaf?.app;
    this.containerEl.children.push(createMockElement("div"), this.contentEl);
  }
  getViewType() {
    return "";
  }
  getDisplayText() {
    return "";
  }
  getIcon() {
    return "";
  }
}

export class Modal {
  app: any;
  contentEl: any = createMockElement("div");
  titleEl: any = createMockElement("div");
  modalEl: any = createMockElement("div");
  constructor(app: any) {
    this.app = app;
  }
  open() {
    this.onOpen();
  }
  close() {
    this.onClose();
  }
  onOpen() {}
  onClose() {}
  setTitle(t: string) {
    this.titleEl.textContent = t;
    return this;
  }
}

export class PluginSettingTab {
  app: any;
  plugin: any;
  containerEl: any = createMockElement("div");
  constructor(app: any, plugin: any) {
    this.app = app;
    this.plugin = plugin;
  }
  display() {}
  hide() {}
}

export class Setting {
  settingEl: any = createMockElement("div");
  controlEl: any = createMockElement("div");
  nameEl: any = createMockElement("div");
  descEl: any = createMockElement("div");
  /** Components added by addText, addToggle, addDropdown... (for tests). */
  components: any[] = [];
  constructor(containerEl?: any) {
    this.settingEl.setting = this;
    if (containerEl && typeof containerEl.appendChild === "function") {
      containerEl.appendChild(this.settingEl);
    }
  }
  setName(n: any) {
    this.nameEl.textContent = typeof n === "string" ? n : "";
    return this;
  }
  setDesc(d: any) {
    this.descEl.textContent = typeof d === "string" ? d : "";
    return this;
  }
  setHeading() {
    return this;
  }
  setClass(c: string) {
    this.settingEl.addClass(c);
    return this;
  }
  addText(cb: any) {
    const comp: any = {
      inputEl: createMockElement("input"),
      value: "",
      setPlaceholder() {
        return comp;
      },
      setValue(v: string) {
        comp.value = v;
        comp.inputEl.value = v;
        return comp;
      },
      getValue() {
        return comp.value;
      },
      onChange(fn: (v: string) => any) {
        comp.changeFn = fn;
        return comp;
      },
    };
    this.components.push(comp);
    if (typeof cb === "function") cb(comp);
    return this;
  }
  addTextArea(cb: any) {
    const comp: any = {
      inputEl: createMockElement("textarea"),
      value: "",
      setPlaceholder() {
        return comp;
      },
      setValue(v: string) {
        comp.value = v;
        comp.inputEl.value = v;
        return comp;
      },
      getValue() {
        return comp.value;
      },
      onChange(fn: (v: string) => any) {
        comp.changeFn = fn;
        return comp;
      },
    };
    this.components.push(comp);
    if (typeof cb === "function") cb(comp);
    return this;
  }
  addToggle(cb: any) {
    const comp: any = {
      toggleEl: createMockElement("div"),
      value: false,
      setValue(v: boolean) {
        comp.value = v;
        return comp;
      },
      getValue() {
        return comp.value;
      },
      onChange(fn: (v: boolean) => any) {
        comp.changeFn = fn;
        return comp;
      },
    };
    this.components.push(comp);
    if (typeof cb === "function") cb(comp);
    return this;
  }
  addButton(cb: any) {
    const comp: any = {
      buttonEl: createMockElement("button"),
      disabled: false,
      setButtonText(t: string) {
        comp.buttonEl.textContent = t;
        return comp;
      },
      setCta() {
        return comp;
      },
      setWarning() {
        return comp;
      },
      setDisabled(d: boolean) {
        comp.disabled = d;
        return comp;
      },
      setIcon(_i: string) {
        return comp;
      },
      setTooltip(_t: string) {
        return comp;
      },
      onClick(fn: () => any) {
        comp.clickFn = fn;
        return comp;
      },
    };
    this.components.push(comp);
    if (typeof cb === "function") cb(comp);
    return this;
  }
  addExtraButton(cb: any) {
    const comp: any = {
      extraSettingsEl: createMockElement("button"),
      setIcon(_i: string) {
        return comp;
      },
      setTooltip(_t: string) {
        return comp;
      },
      onClick(_fn: () => any) {
        return comp;
      },
    };
    this.components.push(comp);
    if (typeof cb === "function") cb(comp);
    return this;
  }
  addDropdown(cb: any) {
    const comp: any = {
      selectEl: createMockElement("select"),
      value: "",
      options: {} as Record<string, string>,
      addOption(k: string, v: string) {
        comp.options[k] = v;
        return comp;
      },
      addOptions(o: Record<string, string>) {
        Object.assign(comp.options, o);
        return comp;
      },
      setValue(v: string) {
        comp.value = v;
        return comp;
      },
      getValue() {
        return comp.value;
      },
      onChange(fn: (v: string) => any) {
        comp.changeFn = fn;
        return comp;
      },
    };
    this.components.push(comp);
    if (typeof cb === "function") cb(comp);
    return this;
  }
}

export class TFile {
  path = "";
  name = "";
  basename = "";
  extension = "";
}
export class TFolder {
  path = "";
  name = "";
  children: any[] = [];
}
export class FileSystemAdapter {
  constructor(private base: string = "") {}
  getBasePath() {
    return this.base;
  }
}

export class WorkspaceLeaf {}


export function getAllTags(cache: any): string[] | null {
  const tags = (cache?.frontmatter?.tags ?? []) as string[];
  return tags.map((t) => `#${t}`);
}

export const MarkdownRenderer = {
  async render(_app: any, _md: string, _el: any, _path: string, _c: any): Promise<void> {},
};
