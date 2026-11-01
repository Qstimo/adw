import { expect,it } from 'vitest';
import { extractSymbols,resolveImport } from '../src/index.js';
it('extracts AST declarations, TSX, imports/exports and literal require/dynamic calls',()=>{
 const text=`import {x} from './x.js';
export {y} from './y';
export interface Shape {size:number}
export type Id = string;
export enum Mode {One}
export class View { render(){return 1} }
export const Component = () => <main/>;
const a=require('node:fs');
const b=import('./dynamic');`;
 const result=extractSymbols(text,'src/view.tsx');
 expect(result.status).toBe('parsed');expect(result.symbols).toEqual(expect.arrayContaining([expect.objectContaining({name:'Shape',kind:'interface',startLine:3}),expect.objectContaining({name:'Component',kind:'function',startLine:7}),expect.objectContaining({name:'render',kind:'method'}),expect.objectContaining({name:'Mode',kind:'enum'})]));
 expect(result.imports.map(i=>[i.specifier,i.kind])).toEqual([['./x.js','import'],['./y','export'],['node:fs','require'],['./dynamic','dynamic']]);
 expect(resolveImport('src/view.tsx','./x.js',new Set(['src/x.ts','src/x.js']))).toBe('src/x.ts');
 expect(resolveImport('src/view.tsx','..',new Set(['index.ts']))).toBe('index.ts');
 expect(resolveImport('src/view.tsx','react',new Set(['react.ts']))).toBeUndefined();
});
it('indexes no fake symbols from comments/strings and marks syntactic errors partial',()=>{
 const result=extractSymbols('// function fake() {}\nconst text="class Fake {}";\nexport function real(){}','x.js');
 expect(result.symbols.map(s=>s.name)).toEqual(['text','real']);
 expect(extractSymbols('export function broken( {','broken.ts').status).toBe('partial');
 expect(extractSymbols('function ignored(){}','README.md').status).toBe('unsupported');
});
it('caps extracted facts with an explicit partial result',()=>{
 const parsed=extractSymbols('export const a=1,b=2,c=3;','x.ts',1);
 expect(parsed.symbols).toHaveLength(1);expect(parsed.status).toBe('partial');expect(parsed.warnings[0]?.message).toContain('resource limit');
});
