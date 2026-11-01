import {app,BrowserWindow,dialog,ipcMain} from 'electron';
import {randomBytes} from 'node:crypto';
import {join,resolve} from 'node:path';
import {CoreProcess} from './core-client.js';
import {createDispatcher} from './host.js';
let core:CoreProcess|undefined;let window:BrowserWindow|undefined;
app.whenReady().then(async()=>{
 const root=resolve(__dirname,'../../..');
 core=new CoreProcess(process.env.ADW_NODE_BINARY||'node',join(root,'packages/core/dist/desktop-core.mjs'),join(app.getPath('userData'),'core'),randomBytes(32).toString('hex'));
 await core.invoke('core.health',{});
 window=new BrowserWindow({width:1280,height:900,minWidth:900,minHeight:650,webPreferences:{preload:join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
 ipcMain.handle('adw:invoke',createDispatcher(window,core,dialog));
 await window.loadFile(join(__dirname,'index.html'));
}).catch(error=>{dialog.showErrorBox('ADW: ошибка запуска',String(error));core?.close();app.quit();});
app.on('window-all-closed',()=>app.quit());app.on('before-quit',()=>core?.close());
