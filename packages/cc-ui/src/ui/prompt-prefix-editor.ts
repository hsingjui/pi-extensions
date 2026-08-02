import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { BASH_PROMPT_PREFIX, PROMPT_PREFIX } from "../constants";
import { isBorderLine } from "../utils";

export class PromptPrefixEditor extends CustomEditor {
  private _bashMode = false;
  private normalBorderColor: (str: string) => string;
  private currentBorderColor: (str: string) => string;
  private bashBorderColor: (str: string) => string;

  // 用于拦截 onSubmit / onChange，在 bash 模式下自动补 ! 前缀
  private _wrappedOnSubmit?: (text: string) => void;
  private _wrappedOnChange?: (text: string) => void;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, appTheme: Theme) {
    super(tui, theme, keybindings);
    this.normalBorderColor = this.borderColor;
    this.currentBorderColor = this.borderColor;
    this.bashBorderColor = appTheme.getBashModeBorderColor();
    this._installBorderColorTracking();
    this._installCallbackWrappers();
  }

  private _installBorderColorTracking(): void {
    Object.defineProperty(this, "borderColor", {
      get: () => this.currentBorderColor,
      set: (fn: ((str: string) => string) | undefined) => {
        if (!fn) return;
        this.currentBorderColor = fn;
        if (!this._bashMode) {
          this.normalBorderColor = fn;
        }
      },
      configurable: true,
      enumerable: true,
    });
  }

  /**
   * 安装 onSubmit / onChange 的包装器。
   *
   * Editor 基类的 submitValue() 直接用 state.lines 构造结果传给 onSubmit，
   * 完全不经过 getText()。因此覆盖 getText() 无法让 pi 核心在提交时
   * 看到 ! 前缀。通过 getter/setter 拦截 onSubmit 回调，在调用时
   * 自动补上 ! 前缀来修复这个问题。onChange 同理。
   */
  private _installCallbackWrappers(): void {
    // 保存当前已有的回调（如果有的话）
    const currentOnSubmit = this.onSubmit;
    const currentOnChange = this.onChange;

    // 定义 onSubmit 的 getter/setter
    Object.defineProperty(this, "onSubmit", {
      get: () => this._wrappedOnSubmit,
      set: (fn: ((text: string) => void) | undefined) => {
        if (!fn) {
          this._wrappedOnSubmit = undefined;
          return;
        }
        this._wrappedOnSubmit = (text: string) => {
          // submitValue() 调用 onSubmit 前已经清空了 state，
          // 但 _bashMode 在此时还未被重置，可以据此判断
          if (this._bashMode && text.length > 0 && !text.startsWith("!")) {
            fn(`!${text}`);
          } else {
            fn(text);
          }
        };
      },
      configurable: true,
      enumerable: true,
    });

    // 定义 onChange 的 getter/setter
    Object.defineProperty(this, "onChange", {
      get: () => this._wrappedOnChange,
      set: (fn: ((text: string) => void) | undefined) => {
        if (!fn) {
          this._wrappedOnChange = undefined;
          return;
        }
        this._wrappedOnChange = (text: string) => {
          if (this._bashMode && text.length > 0 && !text.startsWith("!")) {
            fn(`!${text}`);
          } else {
            fn(text);
          }
        };
      },
      configurable: true,
      enumerable: true,
    });

    // 重新赋值以触发 setter 包装
    if (currentOnSubmit) this.onSubmit = currentOnSubmit;
    if (currentOnChange) this.onChange = currentOnChange;
  }

  handleInput(data: string): void {
    // 文本为空时输入 ! 进入 bash 模式，吃掉该字符
    if (data === "!" && this.getText().length === 0 && !this._bashMode) {
      this._bashMode = true;
      this.borderColor = this.bashBorderColor;
      this.tui.requestRender();
      return;
    }

    super.handleInput(data);

    // bash 模式下文本删空时自动退出
    if (this._bashMode && this.getText().length === 0) {
      this._bashMode = false;
      this.borderColor = this.normalBorderColor;
      this.tui.requestRender();
    }
  }

  get isBashMode(): boolean {
    return this._bashMode;
  }

  // 覆盖 getText / getExpandedText，bash 模式下自动补回 ! 前缀
  // 使 pi 核心的 onChange / onSubmit 能正确检测到 bash 命令
  getText(): string {
    const raw = super.getText();
    return this._bashMode && raw.length > 0 ? `!${raw}` : raw;
  }

  getExpandedText(): string {
    const raw = super.getExpandedText();
    return this._bashMode && raw.length > 0 ? `!${raw}` : raw;
  }

  // 覆盖 setText，若文本以 ! 开头则自动进入 bash 模式并去掉前缀
  setText(text: string): void {
    if (text.startsWith("!") && text.length > 1) {
      this._bashMode = true;
      this.borderColor = this.bashBorderColor;
      super.setText(text.slice(1));
    } else if (text === "") {
      this._bashMode = false;
      this.borderColor = this.normalBorderColor;
      super.setText(text);
    } else {
      super.setText(text);
    }
  }

  private get activePrefix(): string {
    return this._bashMode ? BASH_PROMPT_PREFIX : PROMPT_PREFIX;
  }

  render(width: number): string[] {
    const prefix = this.activePrefix;
    const prefixWidth = visibleWidth(prefix);
    if (width <= prefixWidth + 2) return super.render(width);

    // Editor 基类内部还会为光标/布局预留额外空间。
    // 这里只减 prefixWidth 在某些终端/主题下仍可能溢出 2 列，
    // 所以额外再留 2 列安全边距，避免最终渲染超过终端宽度。
    const innerWidth = Math.max(1, width - prefixWidth - 2);
    const lines = super.render(innerWidth);
    const borderPad = this.borderColor("─".repeat(prefixWidth));
    const coloredPrefix = this.borderColor(prefix);
    const spacerPrefix = " ".repeat(prefixWidth);
    let firstContentLine = true;

    return lines.map((line) => {
      let result: string;
      if (isBorderLine(line)) {
        result = `${borderPad}${line}`;
      } else if (firstContentLine) {
        firstContentLine = false;
        result = `${coloredPrefix}${line}`;
      } else {
        result = `${spacerPrefix}${line}`;
      }

      const renderedWidth = visibleWidth(result);
      if (renderedWidth > width) {
        return truncateToWidth(result, width, "");
      }
      if (renderedWidth < width) {
        return `${result}${" ".repeat(width - renderedWidth)}`;
      }
      return result;
    });
  }
}
