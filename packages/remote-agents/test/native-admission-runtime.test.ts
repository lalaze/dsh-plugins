import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
for(const mode of ['cold-retry','queue-lost','queue-proof-lost','goal-lost'])test(`real admission receipt: ${mode}`,{
 skip:!process.env.DSH_NATIVE_TEST_RUNTIME&&'Set DSH_NATIVE_TEST_RUNTIME to audited installed exports; temporary profiles only',
},async()=>{
 const {stdout}=await promisify(execFile)(process.execPath,['--import','./test/setup.mjs','--import','tsx',fileURLToPath(new URL('./fixtures/native-admission-runtime.mjs',import.meta.url)),process.env.DSH_NATIVE_TEST_RUNTIME!,mode],{cwd:fileURLToPath(new URL('..',import.meta.url)),timeout:45_000,maxBuffer:512*1024,env:{PATH:process.env.PATH,TMPDIR:'/tmp'}});
 const result=JSON.parse(stdout.trim());for(const name of ['realRuntime','importZeroExecution','exactNativeIdentity','noAutomaticReplay','roundTripHandoff'])assert.equal(result[name],true,name);assert.equal(result.localAcceptanceCount,1);
});
