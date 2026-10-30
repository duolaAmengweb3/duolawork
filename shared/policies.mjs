import { HubError } from "./domain.mjs";

// A visible user-controlled tag, never an inferred semantic category.
export function projectType(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > 40)
    throw new HubError("invalid_project_type", "项目类型最多40字", 400);
  return value.trim() || null;
}
export function ruleScope(input, project) {
  const mode = input.scopeMode || (input.projectId === "global" ? "global" : "project");
  if (!["project", "type", "global"].includes(mode))
    throw new HubError("invalid_scope", "规则范围无效", 400);
  if (mode === "type" && !project?.projectType)
    throw new HubError("missing_project_type", "先设置项目类型，再选择同类项目范围", 400);
  const appliesToProjectId = mode === "project" ? project?.id : null;
  if(mode==="project"&&!appliesToProjectId) throw new HubError("missing_project_scope","请选择适用的项目",400);
  return { scopeMode: mode, projectType: mode === "type" ? project.projectType : null, appliesToProjectId };
}
export function ruleApplies(rule, project) {
  const mode = rule.scopeMode || (rule.scopeId === "global" ? "global" : "project");
  return mode === "global" || (mode === "type"
    ? !!project.projectType && rule.projectType === project.projectType
    : (rule.appliesToProjectId || rule.scopeId) === project.id);
}
export const memberSetKey = members => [...new Set(members || [])].sort().join("|");
