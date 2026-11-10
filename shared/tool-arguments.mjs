import {HubError} from './domain.mjs';

// Only documented/observed legacy spellings. Never guess an ID's meaning.
const aliases={stay_silent:{turnId:['stepId']},post_message:{turnId:['stepId']},claim_work:{stepId:['turnId']},read_doc:{documentId:['docId']},edit_doc:{documentId:['docId']},suggest_edit:{documentId:['docId']}};
export function normalizeToolArguments(name,input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new HubError('invalid_arguments','工具参数需要是一个 JSON 对象',400);
 const args={...input};
 for(const [canonical,names] of Object.entries(aliases[name]||{}))for(const alias of names){
  if(args[alias]===undefined)continue;
  if(args[canonical]!==undefined&&args[canonical]!==args[alias])throw new HubError('conflicting_arguments',`${name} 的 ${canonical} 与 ${alias} 不一致，请只提供一个正确编号`,400);
  args[canonical]=args[alias];delete args[alias];
 }
 return args;
}
