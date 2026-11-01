import ts from 'typescript';
import { extname, posix } from 'node:path';
import type { IndexedFile, IndexedSymbol, IndexedImport, IndexWarning } from '@adw/contracts';
export const PARSER_VERSION=`${ts.version}:ast-v1`;
export function languageFor(path:string):IndexedFile['language'] {
 const ext=extname(path).toLowerCase();
 if(['.ts','.mts','.cts'].includes(ext))return 'typescript';if(ext==='.tsx')return 'tsx';
 if(['.js','.mjs','.cjs'].includes(ext))return 'javascript';if(ext==='.jsx')return 'jsx';if(ext==='.json'||ext==='.jsonc')return 'json';return 'text';
}
export function extractSymbols(content:string,path:string,maxFacts=5000):{symbols:IndexedSymbol[];imports:IndexedImport[];warnings:IndexWarning[];status:IndexedFile['symbolStatus']} {
 const language=languageFor(path);
 if(!['typescript','tsx','javascript','jsx'].includes(language))return {symbols:[],imports:[],warnings:[],status:'unsupported'};
 if(maxFacts<1)return {symbols:[],imports:[],warnings:[{code:'parser_error',path,message:'Symbol/import budget exhausted'}],status:'partial'};
 const kind=language==='tsx'?ts.ScriptKind.TSX:language==='jsx'?ts.ScriptKind.JSX:language==='javascript'?ts.ScriptKind.JS:ts.ScriptKind.TS;
 const source=ts.createSourceFile(path,content,ts.ScriptTarget.Latest,true,kind);
 const symbols:IndexedSymbol[]=[],imports:IndexedImport[]=[],warnings:IndexWarning[]=[];
 const line=(position:number)=>source.getLineAndCharacterOfPosition(position).line+1;
 const add=(node:ts.Node,name:string,kind:IndexedSymbol['kind'])=>symbols.push({path,name,kind,startLine:line(node.getStart(source)),endLine:line(Math.max(node.getStart(source),node.getEnd()-1))});
 const moduleRef=(node:ts.Node,specifier:ts.Expression|undefined,kind:IndexedImport['kind'])=>{if(specifier&&(ts.isStringLiteral(specifier)||ts.isNoSubstitutionTemplateLiteral(specifier)))imports.push({path,specifier:specifier.text,kind,startLine:line(node.getStart(source))});};
 const name=(node:ts.DeclarationName|undefined)=>node&&(ts.isIdentifier(node)||ts.isStringLiteral(node)||ts.isNumericLiteral(node))?node.text:undefined;
 const visit=(node:ts.Node)=>{
  if(symbols.length+imports.length>=maxFacts)return;
  if(ts.isFunctionDeclaration(node)){const n=name(node.name);if(n)add(node,n,'function');}
  else if(ts.isClassDeclaration(node)){const n=name(node.name);if(n)add(node,n,'class');}
  else if(ts.isInterfaceDeclaration(node))add(node,node.name.text,'interface');
  else if(ts.isTypeAliasDeclaration(node))add(node,node.name.text,'type');
  else if(ts.isEnumDeclaration(node))add(node,node.name.text,'enum');
  else if(ts.isModuleDeclaration(node)){const n=name(node.name);if(n)add(node,n,'namespace');}
  else if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name))add(node,node.name.text,node.initializer&&(ts.isArrowFunction(node.initializer)||ts.isFunctionExpression(node.initializer))?'function':'variable');
  else if(ts.isMethodDeclaration(node)||ts.isMethodSignature(node)||ts.isGetAccessorDeclaration(node)||ts.isSetAccessorDeclaration(node)){const n=name(node.name);if(n)add(node,n,'method');}
  else if(ts.isPropertyDeclaration(node)||ts.isPropertySignature(node)){const n=name(node.name);if(n)add(node,n,'property');}
  if(ts.isImportDeclaration(node))moduleRef(node,node.moduleSpecifier,'import');
  else if(ts.isExportDeclaration(node))moduleRef(node,node.moduleSpecifier,'export');
  else if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference))moduleRef(node,node.moduleReference.expression,'require');
  else if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||(ts.isIdentifier(node.expression)&&node.expression.text==='require')))moduleRef(node,node.arguments[0],node.expression.kind===ts.SyntaxKind.ImportKeyword?'dynamic':'require');
  ts.forEachChild(node,visit);
 };
 visit(source);
 // createSourceFile exposes syntactic diagnostics on SourceFile in this pinned TS release.
 const diagnostics=(source as ts.SourceFile&{parseDiagnostics?:readonly ts.Diagnostic[]}).parseDiagnostics??[];
 for(const diagnostic of diagnostics.slice(0,20))warnings.push({code:'parser_error',path,message:`Line ${line(diagnostic.start??0)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText,' ')}`});
 if(symbols.length+imports.length>=maxFacts)warnings.push({code:'parser_error',path,message:'Symbol/import extraction reached its resource limit'});
 return {symbols,imports,warnings,status:warnings.length?'partial':'parsed'};
}
export function resolveImport(path:string,specifier:string,files:Set<string>):string|undefined {
 if(!specifier.startsWith('.'))return undefined;
 const target=posix.normalize(posix.join(posix.dirname(path),specifier));if(target==='..'||target.startsWith('../')||posix.isAbsolute(target))return undefined;
 const ext=posix.extname(target),stem=target.slice(0,-ext.length);
 const substituted=ext==='.js'?[stem+'.ts',stem+'.tsx']:ext==='.mjs'?[stem+'.mts']:ext==='.cjs'?[stem+'.cts']:ext==='.jsx'?[stem+'.tsx']:[];
 const candidates=[...substituted,target,...['.ts','.tsx','.mts','.cts','.js','.jsx','.mjs','.cjs','.d.ts','/index.ts','/index.tsx','/index.js'].map(suffix=>target+suffix)];
 return candidates.map(candidate=>posix.normalize(candidate)).find(candidate=>files.has(candidate));
}
