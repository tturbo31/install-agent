import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, type ChatMessage } from "../lib/ai";
function loadEnv(){const c=readFileSync(join(process.cwd(),".env.local"),"utf-8");for(const l of c.split("\n")){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(m){let v=m[2].trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[m[1]]=v;}}}
loadEnv();
async function main(){
  const msgs: ChatMessage[]=[{role:"user",content:"Do you offer any discounts for larger spaces and is there a military discount?"}];
  const t0=Date.now();
  try{const r=await getAIResponse(msgs,null,null,null,false);console.log(`API OK in ${Date.now()-t0}ms`);console.log("REPLY:",r.text.slice(0,160));}
  catch(e){const err=e as {status?:number;message?:string};console.error(`API FAILED in ${Date.now()-t0}ms | status:${err.status} | ${err.message?.slice(0,220)}`);}
}
main();
