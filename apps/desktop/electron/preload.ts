import {contextBridge,ipcRenderer} from 'electron';
// Keep sandboxed preload free of Node dependencies (including bundled Zod).
const allowed=['project.pick','project.getStatus','project.setPrivacy','task.createDraft','task.updateDraft','task.confirmSpec','task.get','task.start','task.cancel','task.subscribeEvents','context.getProjectMap','context.getDecisions','context.getArtifact','verification.getMatrix','evidence.read','review.getVerdict','review.acceptPatch','review.rejectPatch'];
contextBridge.exposeInMainWorld('adw',Object.freeze({invoke(method: string,params:unknown){if(!allowed.includes(method))return Promise.reject(new Error('Forbidden IPC method'));return ipcRenderer.invoke('adw:invoke',method,params);}}));
