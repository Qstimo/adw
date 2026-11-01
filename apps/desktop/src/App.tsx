import {useState} from 'react';
import type {DesktopProject,DesktopTask} from '@adw/contracts';
import {client} from './ipc/client.js';
import {ErrorMessage} from './shared.js';
import {ProjectScreen} from './screens/ProjectScreen.js';
import {TaskScreen} from './screens/TaskScreen.js';
import {ContextExplorer} from './screens/ContextExplorer.js';
import {VerificationScreen} from './screens/VerificationScreen.js';
import {ReviewScreen} from './screens/ReviewScreen.js';
const tabs=['Проект','Задача','Контекст','Верификация','Review'];
export function App(){const [project,setProject]=useState<DesktopProject>();const [task,setTask]=useState<DesktopTask>();const [tab,setTab]=useState(0);const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [taskLink,setTaskLink]=useState(location.hash.slice(1));
 async function act(f:()=>Promise<void>){setError('');setBusy(true);try{await f();}catch(error){setError(String(error));}finally{setBusy(false);}}
 function selected(next:DesktopTask){setTask(next);setTaskLink(next.spec.id);location.hash=next.spec.id;}
 async function refreshTask(){if(task)selected(await client.invoke('task.get',{taskId:task.spec.id}));}
 return <><header><strong>ADW</strong><span>{project?.path||'Выберите проект'}</span></header><nav>{tabs.map((name,i)=><button key={name} aria-current={i===tab?'page':undefined} disabled={busy||(i>0&&!project)||(i>1&&!task)} onClick={()=>setTab(i)}>{name}</button>)}</nav><main><ErrorMessage error={error}/>{busy&&<p role="status">Выполняется…</p>}<fieldset disabled={busy} className="shell"><div className="task-select">{project&&<><label>Task ID<input value={taskLink} onChange={e=>setTaskLink(e.target.value)}/></label><button onClick={()=>void act(async()=>{selected(await client.invoke('task.get',{taskId:taskLink}));setTab(1);})}>Открыть задачу</button><button onClick={()=>{setTask(undefined);location.hash='';setTaskLink('');setTab(1);}}>Новая задача</button></>}</div>{tab===0&&<ProjectScreen project={project} onProject={next=>{if(next.id!==project?.id){setTask(undefined);location.hash='';}setProject(next);}} onTask={next=>{selected(next);setTab(1);}} act={f=>void act(f)}/>}{tab===1&&project&&<TaskScreen key={task?.spec.id||project.id} project={project} task={task} onTask={selected} act={f=>void act(f)}/>}{tab===2&&task&&<ContextExplorer key={task.spec.id} taskId={task.spec.id}/>}{tab===3&&task&&<VerificationScreen key={task.spec.id} task={task}/>}{tab===4&&task&&<ReviewScreen key={task.spec.id} taskId={task.spec.id} act={f=>void act(f)} onChanged={refreshTask}/>}</fieldset></main></>;}
