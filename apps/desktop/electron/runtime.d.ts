// Minimal host API surface; Electron is an external runtime, never bundled.
declare module 'electron' {
 export const app: {whenReady():Promise<void>;getPath(name:string):string;on(event:string,listener:(...args:any[])=>void):void;quit():void};
 export class BrowserWindow {constructor(options:unknown); webContents:{mainFrame:unknown;setWindowOpenHandler(handler:()=>{action:string}):void;on(event:string,listener:(event:{preventDefault():void})=>void):void};loadFile(path:string):Promise<void>;on(event:string,listener:()=>void):void;destroy():void;}
 export const ipcMain:{handle(channel:string,listener:(event:{sender:unknown;senderFrame:unknown},method:unknown,params:unknown)=>unknown):void};
 export const ipcRenderer:{invoke(channel:string,method:unknown,params:unknown):Promise<unknown>};
 export const contextBridge:{exposeInMainWorld(name:string,value:unknown):void};
 export const dialog:{showErrorBox(title:string,content:string):void;showOpenDialog(window:BrowserWindow,options:unknown):Promise<{canceled:boolean;filePaths:string[]}>;showMessageBox(window:BrowserWindow,options:unknown):Promise<{response:number}>};
}
