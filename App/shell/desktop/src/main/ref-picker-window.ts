/**
 * Memmy 引用浮窗：⌥⌘R 唤起，选中项目关联的会话，把引用块和问题一起交给当前的前台应用。
 *
 * 为什么是浮窗而不是输入框里的标签：在其他 Agent 的输入框里插入内容做不到，
 * 只能借系统剪贴板/模拟按键；选择这一步放在 Memmy 自己的窗口里，用户就不用记命令。
 */
import { app, clipboard, globalShortcut, ipcMain, screen, BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const REF_PICKER_SHORTCUT = 'Alt+Command+R';
const REF_PICKER_CHANNELS = {
  list: 'memmy:ref-picker:list',
  submit: 'memmy:ref-picker:submit',
  indexStatus: 'memmy:ref-picker:index-status',
  indexFull: 'memmy:ref-picker:index-full',
  close: 'memmy:ref-picker:close'
} as const;

/** 关联时一次带入的最近会话数：够验证，也不至于把整台机器都塞进项目。 */
const ASSOCIATE_RECENT_SESSIONS = 20;

interface RefPickerSession {
  sourceId: string;
  agentName: string;
  conversationId: string;
  title: string;
  lastQuestion: string;
  updatedAt: string;
  turnCount: number;
  workspacePath?: string | null;
  /** 会话状态（进行中/已中断），索引暂时留空，界面按有无显示。 */
  status?: string | null;
}

interface RefPickerSubmitInput {
  /** 选中的会话，支持多选；每个会话生成一段引用。 */
  sessions: Array<{ sourceId: string; conversationId: string }>;
  question: string;
  paste: boolean;
}

let refPickerWindow: BrowserWindow | null = null;
let registered = false;

/** 粘贴失败要能查：写进应用日志目录，界面之外还有据可依。 */
function logPaste(message: string): void {
  try {
    appendFileSync(join(app.getPath('logs'), 'ref-picker.log'), `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    // 日志写不进去也不能影响引用本身
  }
}

/** 本机 Memory 服务的地址：与其他模块一致，允许环境变量覆盖以便测试。 */
function memoryUrl(): string {
  return (process.env.MEMMY_MEMORY_URL?.trim() || 'http://127.0.0.1:18960').replace(/\/+$/u, '');
}

async function memoryRequest<T>(path: string, body: unknown, method: 'GET' | 'POST' = 'POST'): Promise<T> {
  const response = await fetch(`${memoryUrl()}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(parsed?.error?.message || `${path} ${response.status}`);
  }
  return parsed as T;
}

function createRefPickerWindow(): BrowserWindow {
  // 在哪个屏幕唤起就显示在哪个屏幕：用鼠标位置判断用户当前在看的屏幕。
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { width, height } = display.workAreaSize;
  const windowWidth = 560;
  const windowHeight = 620;
  const window = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: Math.round(display.workArea.x + (width - windowWidth) / 2),
    y: Math.round(display.workArea.y + (height - windowHeight) / 3),
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/ref-picker.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  window.setAlwaysOnTop(true, 'floating');
  window.loadFile(join(import.meta.dirname, 'ref-picker.html')).catch((error: unknown) => {
    console.error('[ref-picker] load failed', error);
  });
  // 关闭只隐藏：全局快捷键要继续可用。
  window.on('close', (event) => {
    event.preventDefault();
    window.hide();
  });
  window.on('blur', () => window.hide());
  return window;
}

function showRefPicker(): void {
  if (!refPickerWindow || refPickerWindow.isDestroyed()) {
    refPickerWindow = createRefPickerWindow();
  } else {
    // 多显示器：每次唤起都移到当前鼠标所在屏幕，否则会跑到主屏。
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const size = refPickerWindow.getSize();
    const windowWidth = size[0] ?? 560;
    const windowHeight = size[1] ?? 620;
    refPickerWindow.setPosition(
      Math.round(display.workArea.x + (display.workArea.width - windowWidth) / 2),
      Math.round(display.workArea.y + (display.workArea.height - windowHeight) / 3)
    );
  }
  refPickerWindow.show();
  refPickerWindow.focus();
  // 每次唤起都重新取一次，避免看到上次的旧列表。
  refPickerWindow.webContents.send('memmy:ref-picker:show');
}

/**
 * 把 ⌘V 发给刚才的窗口。
 * 关键点是 app.hide()：只隐藏窗口不会把应用切到后台，macOS 就不会把焦点还回去，
 * 按键会落空；隐藏整个应用后，系统才会重新激活上一个应用。
 */
function pasteIntoFrontApp(): Promise<string> {
  if (process.platform !== 'darwin') {
    return Promise.resolve('unsupported');
  }
  return new Promise((resolve) => {
    setTimeout(() => {
      execFile(
        '/usr/bin/osascript',
        ['-e', 'tell application "System Events" to keystroke "v" using command down'],
        // 系统在弹授权框时 osascript 可能一直不返回，超时后按失败处理，避免界面卡住。
        { timeout: 4000 },
        (error, _stdout, stderr) => {
          if (error) {
            const detail = `${error.message} ${String(stderr || '').trim()}`.trim();
            logPaste(`paste failed: ${detail}`);
            resolve(detail || 'paste failed');
            return;
          }
          logPaste('paste ok');
          resolve('');
        }
      );
    }, 320);
  });
}

/** 引用块的文本形态：Agent 先读文件，再回答问题。问题只在块外出现一次。 */
function referenceBlock(reference: RefPickerSession & { path: string }): string {
  return [
    '<memmy_reference>',
    `已引用 ${reference.agentName} 的会话「${reference.title}」（共 ${reference.turnCount} 轮）。`,
    `完整记录：${reference.path}`,
    '回答与该会话相关的问题前，先读取此文件。',
    '</memmy_reference>'
  ].join('\n');
}

/** 注册浮窗、快捷键与 IPC。重复调用无副作用。 */
export function registerMemmyRefPicker(): void {
  if (registered) {
    return;
  }
  registered = true;
  // 允许重复进入：模块被重复求值时会让 handle 抛错，进而把主进程启动打崩。
  for (const channel of Object.values(REF_PICKER_CHANNELS)) {
    ipcMain.removeHandler(channel);
  }

  ipcMain.handle(REF_PICKER_CHANNELS.submit, async (_event, input: RefPickerSubmitInput) => {
    const picked = Array.isArray(input?.sessions) ? input.sessions : [];
    if (!picked.length) {
      return { pasted: false, copied: false, error: '没有选中会话' };
    }
    const blocks: string[] = [];
    for (const session of picked) {
      const reference = await memoryRequest<RefPickerSession & { path: string }>(
        '/api/v1/agent-sessions/reference',
        { sourceId: session.sourceId, conversationId: session.conversationId }
      );
      blocks.push(referenceBlock(reference));
    }
    const ask = input.question.trim();
    const block = [...blocks, ...(ask ? [ask] : [])].join('\n\n');
    clipboard.writeText(block);
    if (!input.paste) {
      refPickerWindow?.hide();
      return { pasted: false, copied: true };
    }
    // 整个应用退到后台，焦点才会回到用户刚才所在的窗口。
    app.hide();
    const failure = await pasteIntoFrontApp();
    if (failure) {
      // 失败时把窗口还回来：剪贴板里已经有内容，用户看到提示就知道可以手动 ⌘V。
      refPickerWindow?.show();
      refPickerWindow?.focus();
      return { pasted: false, copied: true, error: failure };
    }
    return { pasted: true, copied: true };
  });

  // 列表与搜索读本机索引：打开即用，不用等扫描。
  ipcMain.handle(REF_PICKER_CHANNELS.list, async (_event, input: unknown) => {
    const request = (input ?? {}) as { query?: unknown; sourceIds?: unknown };
    const result = await memoryRequest<{ sessions?: RefPickerSession[]; status?: unknown }>(
      '/api/v1/local-sessions/search',
      {
        query: typeof request.query === 'string' ? request.query : '',
        sourceIds: Array.isArray(request.sourceIds) ? request.sourceIds : undefined,
        limit: 5000
      }
    );
    return { sessions: result.sessions ?? [], status: result.status ?? null };
  });

  ipcMain.handle(REF_PICKER_CHANNELS.indexStatus, async () => {
    const result = await memoryRequest<{ status?: unknown }>('/api/v1/local-sessions/index', {});
    return result.status ?? null;
  });

  // 全量索引在服务里后台跑，这里只负责触发并回报状态。
  ipcMain.handle(REF_PICKER_CHANNELS.indexFull, async () => {
    const result = await memoryRequest<{ status?: unknown }>('/api/v1/local-sessions/index', {});
    return result.status ?? null;
  });

  ipcMain.handle(REF_PICKER_CHANNELS.close, () => {
    refPickerWindow?.hide();
  });

  refPickerWindow = createRefPickerWindow();
  const ok = globalShortcut.register(REF_PICKER_SHORTCUT, showRefPicker);
  if (!ok) {
    // 快捷键被占用时至少让窗口可达，否则功能等于不存在。
    console.warn('[ref-picker] shortcut unavailable, showing window once');
    refPickerWindow.once('ready-to-show', () => refPickerWindow?.show());
  }
}

/** 退出前释放快捷键与 IPC。 */
export function disposeMemmyRefPicker(): void {
  if (!registered) {
    return;
  }
  registered = false;
  globalShortcut.unregister(REF_PICKER_SHORTCUT);
  for (const channel of Object.values(REF_PICKER_CHANNELS)) {
    ipcMain.removeHandler(channel);
  }
  if (refPickerWindow && !refPickerWindow.isDestroyed()) {
    refPickerWindow.destroy();
  }
  refPickerWindow = null;
}
