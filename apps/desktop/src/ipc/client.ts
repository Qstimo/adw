import {DesktopMethods,type DesktopClient,type DesktopMethod,type DesktopParams,type DesktopResult} from '@adw/contracts';
declare global {interface Window {adw:DesktopClient}}
export const client:DesktopClient={async invoke<M extends DesktopMethod>(method:M,params:DesktopParams<M>):Promise<DesktopResult<M>>{const result=await window.adw.invoke(method,DesktopMethods[method].params.parse(params) as DesktopParams<M>);return DesktopMethods[method].result.parse(result) as DesktopResult<M>;}};
