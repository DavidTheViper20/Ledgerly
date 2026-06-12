'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ledgerly', {
  async call(method, args) {
    const res = await ipcRenderer.invoke('api', method, args);
    if (!res.ok) {
      const err = new Error(res.error);
      err.isApiError = true;
      throw err;
    }
    return res.data;
  },
  exportPdf(name) { return ipcRenderer.invoke('export-pdf', name); },
  openCsv() { return ipcRenderer.invoke('open-csv'); },
  capture(file) { return ipcRenderer.invoke('capture', file); },
  async assistant(method, args) {
    const res = await ipcRenderer.invoke('assistant', method, args);
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  // Streaming chat: onEvent receives { type: 'status'|'thinking'|'reply'|'tool', ... }
  // while the model works; the returned promise resolves with the final
  // { reply, toolsUsed, sources }.
  async assistantStream(args, onEvent) {
    const id = Math.random().toString(36).slice(2);
    const listener = (_e, msg) => { if (msg.id === id) try { onEvent(msg); } catch {} };
    ipcRenderer.on('assistant-stream-event', listener);
    try {
      const res = await ipcRenderer.invoke('assistant-stream', id, args);
      if (!res.ok) throw new Error(res.error);
      return res.data;
    } finally {
      ipcRenderer.removeListener('assistant-stream-event', listener);
    }
  },
  openExternal(url) { return ipcRenderer.invoke('open-external', url); },
  async orgs(method, args) {
    const res = await ipcRenderer.invoke('orgs', method, args);
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
});
