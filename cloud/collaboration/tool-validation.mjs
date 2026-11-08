import {CfWorkerJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/cfworker-provider.js';
import {fail} from './repository.mjs';
const factory=new CfWorkerJsonSchemaValidator(),cache=new Map();
export function validateToolArguments(definition,args){
 if(!definition)return;
 const original=definition.inputSchema;
 // Legacy submit_work also carries an ordinary chat reply. Its existing route
 // uses the member's current conversation turn rather than a formal task lease.
 const chatSubmit=definition.name==='submit_work'&&args.attemptId?.startsWith('turn_');
 const schema={...original,additionalProperties:true,...(chatSubmit?{required:['requestId','attemptId','items']}:{})};
 // Inbox already exposes the stable invalid_wait error for its bounded wait.
 if(['receive_messages','claim_work'].includes(definition.name)&&schema.properties?.waitSeconds)schema.properties={...schema.properties,waitSeconds:{type:'integer'}};
 const missing=(schema.required||[]).filter(k=>args[k]===undefined);
 if(missing.length)fail('invalid_arguments',`工具 ${definition.name} 缺少必要参数：${missing.join('、')}。请按工具定义补齐`,400);
 const key=definition.name+':'+(chatSubmit?'chat':'normal');
 let validate=cache.get(key);if(!validate){validate=factory.getValidator(schema);cache.set(key,validate);}
 const result=validate(args);
 if(!result.valid)fail('invalid_arguments',`工具 ${definition.name} 参数格式不正确，请按工具定义中的字段类型填写；未执行本次操作`,400);
}
