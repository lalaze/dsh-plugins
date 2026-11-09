import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
for (const mode of ['lifecycle','expired','lost-reply']) test(`real ScheduleService: ${mode}`, {
  skip: !process.env.DSH_NATIVE_TEST_RUNTIME && 'Set DSH_NATIVE_TEST_RUNTIME; isolated storage and stub LLM only',
}, async () => {
 const {stdout}=await promisify(execFile)(process.execPath,['--import','./test/setup.mjs','--import','tsx',fileURLToPath(new URL('./fixtures/native-schedule-runtime.mjs',import.meta.url)),process.env.DSH_NATIVE_TEST_RUNTIME!,mode],{cwd:fileURLToPath(new URL('..',import.meta.url)),timeout:45_000,maxBuffer:512*1024,env:{PATH:process.env.PATH,TMPDIR:'/tmp'}});
 const result=JSON.parse(stdout.trim());for(const key of ['realScheduleService','sourcePauseCAS','importZeroCreate','originalPausedStaysPaused','roundTripCheckpoint'])assert.equal(result[key],true,key);
});

test('real native manager: three-level cold import, receiver permissions, aliases, canonical return, and real read cwd', {
 skip:!process.env.DSH_NATIVE_TEST_RUNTIME && 'Set DSH_NATIVE_TEST_RUNTIME; no profile is loaded',
},async()=>{
 const {stdout}=await promisify(execFile)(process.execPath,['--import','./test/setup.mjs','--import','tsx',fileURLToPath(new URL('./fixtures/native-subtree-runtime.mjs',import.meta.url)),process.env.DSH_NATIVE_TEST_RUNTIME!],{cwd:fileURLToPath(new URL('..',import.meta.url)),timeout:45_000,maxBuffer:512*1024,env:{PATH:process.env.PATH,TMPDIR:'/tmp'}});
 const result=JSON.parse(stdout.trim());for(const key of ['threeLevels','sourceFullAccessRecorded','coldImportZeroExecution','childReceiverReadOnly','grandchildReceiverReadOnly','scopedHistoricalAliases','skipLevelDenied','unrelatedDenied','returnChildReadOnly','rawUserToolVerbatim','roundTripCheckpoint','realReadCwdAtoBtoA'])assert.equal(result[key],true,key);
});
