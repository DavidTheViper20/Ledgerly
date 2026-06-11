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
});
