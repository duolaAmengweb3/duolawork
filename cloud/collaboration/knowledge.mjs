import { ruleApplies } from "../../shared/policies.mjs";

export async function indexKnowledge(tx, item) {
  const mode=item.scopeMode || (item.scopeId === "global" ? "global" : "project");
  tx.put("knowledge_applicability", {
    id:item.id, scopeId: mode === "type" ? `type:${item.projectType}` : mode === "global" ? "global" : `project:${item.appliesToProjectId || item.scopeId}`,
    status:item.status, knowledgeId:item.id,
  });
}
export async function applicableKnowledge(tx, project, status) {
  const direct=[...await tx.list("knowledge",{scope:project.id,status,limit:501}),...await tx.list("knowledge",{scope:"global",status,limit:501})];
  const pointers=[...await tx.list("knowledge_applicability",{scope:`project:${project.id}`,status,limit:501}),...await tx.list("knowledge_applicability",{scope:"global",status,limit:501}),...(project.projectType ? await tx.list("knowledge_applicability",{scope:`type:${project.projectType}`,status,limit:501}) : [])];
  for (const pointer of pointers) {
    const item=await tx.get("knowledge",pointer.knowledgeId,false);
    if (item?.status===status) direct.push(item);
  }
  return [...new Map(direct.filter(k=>ruleApplies(k,project)).map(k=>[k.id,k])).values()];
}
