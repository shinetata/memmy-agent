const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

// 引用浮窗的桥：只暴露列表、提交、关闭三个动作，页面拿不到 Node 能力。
contextBridge.exposeInMainWorld('memmyRefPicker', {
  searchSessions(input: { query?: string; sourceIds?: string[] }) {
    return ipcRenderer.invoke('memmy:ref-picker:list', input);
  },
  indexStatus() {
    return ipcRenderer.invoke('memmy:ref-picker:index-status');
  },
  indexFull() {
    return ipcRenderer.invoke('memmy:ref-picker:index-full');
  },
  submit(input: { sourceId: string; conversationId: string; question: string; paste: boolean }) {
    return ipcRenderer.invoke('memmy:ref-picker:submit', input);
  },
  close() {
    return ipcRenderer.invoke('memmy:ref-picker:close');
  },
  onShow(handler: () => void) {
    ipcRenderer.on('memmy:ref-picker:show', () => handler());
  }
});
