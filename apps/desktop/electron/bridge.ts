import {DesktopMethods,DesktopRendererMethods,type DesktopMethod} from '@adw/contracts';
export function rendererRequest(method:unknown,params:unknown):{method:DesktopMethod;params:unknown} {
 if(typeof method!=='string'||!DesktopRendererMethods.includes(method as DesktopMethod)) throw new Error('Forbidden IPC method');
 const name=method as DesktopMethod;
 return {method:name,params:DesktopMethods[name].params.parse(params)};
}
