// Fresh Node process: no module-global seen-ID cache survives from the parent test.
import assert from 'node:assert/strict';
import { ClaudeGoalOrigins } from '../../src/chat/claude-goal-origin.ts';
const ledger=new ClaudeGoalOrigins(process.argv[2]);await ledger.open();
const nativeSessionId='native-session',b={epoch:'child-b',messageId:'B-child',uuid:'uuid-child-b',nativeSessionId};
await ledger.send(b);
const frame=(responseId,callId,uuid)=>({type:'assistant',session_id:nativeSessionId,parent_tool_use_id:null,...uuid?{user_message_uuid:uuid}:{},message:{id:responseId,content:[{type:'tool_use',id:callId,name:'mcp__dsh-goal__get_goal',input:{}}]}});
assert.deepEqual(ledger.observe(frame('a-response','reused-response-call',b.uuid),nativeSessionId,b.messageId),[]);
assert.deepEqual(ledger.observe(frame('child-b-response','old-call',b.uuid),nativeSessionId,b.messageId),[]);
assert.deepEqual(ledger.observe(frame('child-b-response','unbound-old'),nativeSessionId,b.messageId),[]);
const fresh=ledger.observe(frame('child-b-response','child-fresh'),nativeSessionId,b.messageId);assert.equal(fresh.length,1);assert.equal(fresh[0].uuid,b.uuid);
assert.equal(ledger.resultMatches({type:'result',session_id:nativeSessionId,user_message_uuid:'old-A'},nativeSessionId,b.messageId),false);
assert.equal(ledger.resultMatches({type:'result',session_id:nativeSessionId,user_message_uuid:b.uuid},nativeSessionId,b.messageId),true);
assert.equal(await ledger.flush(),true);
console.log(JSON.stringify({freshProcess:true,oldResponseRejected:true,oldCallRejected:true,unboundCallRejected:true,freshCallAccepted:true,oldResultRejected:true}));
