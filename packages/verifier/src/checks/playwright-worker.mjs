import {readFileSync,writeFileSync,mkdirSync,unlinkSync,statSync} from 'node:fs';
import {join,relative,dirname} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),request=JSON.parse(readFileSync(0,'utf8'));
const {chromium}=require(request.modulePath);const {outputDir,baseUrl,scenarios}=request;mkdirSync(outputDir,{recursive:true});
const report={observations:[],artifacts:[],proves:'scenario_observation',runtime:{playwrightVersion:JSON.parse(readFileSync(join(dirname(request.modulePath),'package.json'),'utf8')).version}};let browser;
const safeUrl=value=>{try{const url=new URL(value);url.username='';url.password='';url.search='';url.hash='';return url.href;}catch{return '[invalid URL]';}};
try{
 browser=await chromium.launch({headless:true,timeout:Math.min(request.timeoutMs,15000),...(request.browserExecutable?{executablePath:request.browserExecutable}:{})});
 report.runtime.browserVersion=browser.version();report.runtime.executablePath=request.browserExecutable??chromium.executablePath();
 for(let i=0;i<scenarios.length;i++){
  const scenario=scenarios[i],logs=[],network=[];let context,page,error,resourceLimit=false,logBytes=0;
  const record=(target,event)=>{const bytes=Buffer.byteLength(JSON.stringify(event));if(logBytes+bytes>65536||target.length>=500){resourceLimit=true;return;}logBytes+=bytes;target.push(event);};
  const artifact=(path,mediaType,role)=>report.artifacts.push({path,mediaType,role,scenario:scenario.title});
  try{
   context=await browser.newContext({viewport:{width:1024,height:768},recordVideo:{dir:join(outputDir,'videos'),size:{width:1024,height:768}},serviceWorkers:'block'});
   await context.route('**/*',route=>{const url=new URL(route.request().url());return url.origin===new URL(baseUrl).origin?route.continue():route.abort('blockedbyclient');});
   page=await context.newPage();page.setDefaultTimeout(Math.min(request.timeoutMs,10000));
   page.on('console',message=>record(logs,{type:message.type(),text:message.text()}));page.on('pageerror',value=>record(logs,{type:'error',text:String(value)}));
   page.on('response',response=>record(network,{url:safeUrl(response.url()),method:response.request().method(),status:response.status()}));
   page.on('requestfailed',req=>record(network,{url:safeUrl(req.url()),method:req.method(),failure:req.failure()?.errorText}));
   const url=new URL(scenario.path,baseUrl);if(url.origin!==new URL(baseUrl).origin)throw new Error('Cross-origin navigation');
   const response=await page.goto(url.href,{waitUntil:'networkidle'});if(!response?.ok())throw new Error('Page navigation failed');
   for(const step of scenario.steps){const locator=page.locator(step.selector);if(step.action==='click')await locator.click();else if(step.action==='visible')await locator.waitFor({state:'visible'});else{await locator.waitFor({state:'visible'});const deadline=Date.now()+Math.min(request.timeoutMs,10000);let actual=await locator.innerText();while(actual!==step.expected&&Date.now()<deadline){await page.waitForTimeout(25);actual=await locator.innerText();}if(actual!==step.expected)throw new Error(`Expected ${JSON.stringify(step.expected)} at ${step.selector}, got ${JSON.stringify(actual)}`);}}
   if(request.failOnConsoleError&&logs.some(log=>log.type==='error'))throw new Error('Browser console/page error');
  }catch(value){error=String(value);}
  if(!page)resourceLimit=true;
  if(page){try{await page.screenshot({path:join(outputDir,`${i}.png`),fullPage:false,timeout:3000});artifact(`${i}.png`,'image/png','screenshot');}catch(value){error??=String(value);resourceLimit=true;}
   try{const dom=await page.content();if(Buffer.byteLength(dom)>1024*1024){resourceLimit=true;throw new Error('DOM evidence exceeds limit');}writeFileSync(join(outputDir,`${i}.html`),dom);artifact(`${i}.html`,'text/html','dom');}catch(value){error??=String(value);}}
  writeFileSync(join(outputDir,`${i}.console.json`),JSON.stringify(logs));artifact(`${i}.console.json`,'application/json','console');
  writeFileSync(join(outputDir,`${i}.network.json`),JSON.stringify(network));artifact(`${i}.network.json`,'application/json','network');
  const video=page?.video();try{await context?.close();if(video){const path=await video.path();if(error||resourceLimit)artifact(relative(outputDir,path),'video/webm','video');else unlinkSync(path);}}catch(value){error??=String(value);resourceLimit=true;}
  report.observations.push({title:scenario.title,status:resourceLimit?'not_verified':error?'failed':'passed',...(error?{reason:error}:{})});
 }
}catch(error){report.launchError=String(error);report.observations=scenarios.map(scenario=>({title:scenario.title,status:'not_verified',reason:'Browser unavailable; see launch evidence'}));}
finally{try{await browser?.close();}catch{}writeFileSync(join(outputDir,'report.json'),JSON.stringify(report));}
process.exitCode=report.observations.every(test=>test.status==='passed')?0:report.observations.some(test=>test.status==='not_verified')?2:1;
