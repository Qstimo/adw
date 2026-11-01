import {DesktopHumanMethods} from '@adw/contracts';
import type {BrowserWindow,dialog as nativeDialog} from 'electron';
import {rendererRequest} from './bridge.js';
export function createDispatcher(window:BrowserWindow,core:{invoke(method:import('@adw/contracts').DesktopMethod,params:unknown,human?:boolean):Promise<unknown>},dialog:typeof nativeDialog){let busy=false;
 return async(event:{sender:unknown;senderFrame:unknown},method:unknown,params:unknown)=>{
  if(!window||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('Untrusted sender');
  const request=rendererRequest(method,params);
  if(busy)throw new Error('Native confirmation in progress');
  if(request.method==='project.pick'){
   busy=true;try{const selection=await dialog.showOpenDialog(window,{properties:['openDirectory'],title:'Выберите Git-проект'});if(selection.canceled||!selection.filePaths[0])return null;return await core.invoke('project.open',{path:selection.filePaths[0]});}finally{busy=false;}
  }
  if(DesktopHumanMethods.has(request.method)){
   busy=true;try{
    // Build approval from current core data and verify the renderer's preview hashes.
    const p=request.params as {taskId:string;expectedSpecHash?:string;expectedPolicyHash?:string;reviewId?:string;reason?:string};
    const task=await core.invoke('task.get',{taskId:p.taskId}) as import('@adw/contracts').DesktopTask;
    let detail=`Задача: ${task.spec.id}\n${task.spec.intent}\n\nКритерии:\n${task.spec.acceptance.join('\n')}\n\nПолитика:\n${JSON.stringify(task.policy,null,2)}`;
    if(request.method==='task.confirmSpec'&&(task.specHash!==p.expectedSpecHash||task.policyHash!==p.expectedPolicyHash))throw new Error('Preview changed; refresh task');
    if(request.method==='review.acceptPatch'){const review=await core.invoke('review.getVerdict',{taskId:p.taskId}) as {verdict:{id:string}|null};if(review.verdict?.id!==p.reviewId)throw new Error('Review changed; refresh');detail+=`\nReview: ${p.reviewId}\nПринять проверенный patch в managed acceptance branch.`;}
    if(request.method==='review.rejectPatch')detail+=`\nУдалить managed worktree. Причина: ${p.reason}`;
    const answer=await dialog.showMessageBox(window,{type:'warning',title:request.method,message:'Подтвердите действие',detail,buttons:['Отмена','Подтвердить'],defaultId:0,cancelId:0,noLink:true});
    if(answer.response!==1)throw new Error('Действие отменено');return await core.invoke(request.method,request.params,true);
   }finally{busy=false;}
  }
  return core.invoke(request.method,request.params);
 };
}
