import {useEffect,useState} from 'react';
export function useLoad<T>(load:()=>Promise<T>,deps:unknown[]){const [data,setData]=useState<T>();const [error,setError]=useState('');const [version,refresh]=useState(0);useEffect(()=>{let active=true;setData(undefined);setError('');load().then(value=>{if(active)setData(value);},err=>{if(active)setError(String(err));});return()=>{active=false;};},[...deps,version]);return {data,error,refresh:()=>refresh(n=>n+1)};}
export function ErrorMessage({error}:{error:string}){return error?<p role="alert">{error}</p>:null;}
export function Json({value}:{value:unknown}){return <pre>{JSON.stringify(value,null,2)}</pre>;}
