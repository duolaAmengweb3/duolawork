import BUILD from "../../shared/build-info.json";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Layers,
  MessageSquare,
  FileText,
  Inbox,
  BookOpen,
  Users,
  Settings,
  Plus,
  Search,
  ArrowRight,
  Check,
  ChevronDown,
  SlidersHorizontal,
  Clock,
  PanelRight,
  RefreshCw,
  Paperclip,
  ArrowUp,
  Link2,
  AlertCircle,
  Copy,
  X,
  Folder,
  Pause,
  Play,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { CheckSummary } from "./SelfCheck.jsx";
const Document = React.lazy(() => import("./Document.jsx"));
import {
  api,
  command,
  records,
  time,
  label,
  memberName,
  upload,
} from "./api.mjs";
import { COLLAB_MODES } from "../../shared/modes.mjs";
import { PairingFacts, ResultFilters, RuleScope, RuleNotice, RunHistory } from "./Support.jsx";
function Face({ member }) {
  return (
    <Avatar className="size-8 shrink-0">
      <AvatarFallback
        className={
          member?.platformId === "grok-bot"
            ? "bg-slate-800 text-white"
            : "bg-teal-700 text-white"
        }
      >
        {member?.name?.slice(0, 1) || "我"}
      </AvatarFallback>
    </Avatar>
  );
}
function Empty({ title, body, children }) {
  return (
    <div className="empty">
      <Layers size={32} strokeWidth={1.4} />
      <h2>{title}</h2>
      <p>{body}</p>
      {children}
    </div>
  );
}
function State({ status }) {
  return (
    <Badge
      variant="secondary"
      className={
        status === "verified" || status === "completed"
          ? "state-green"
          : ["needs_review", "partially_met"].includes(status)
            ? "state-red"
            : ""
      }
    >
      <i className="status-dot" />
      {label(status)}
    </Badge>
  );
}
export default function App() {
  const [page, setPage] = useState("projects"),
    [workspace, setWorkspace] = useState(null),
    [projects, setProjects] = useState([]),
    [projectCursor,setProjectCursor]=useState(null),
    [projectId, setProjectId] = useState(
      () => localStorage.getItem("agent-hub-current-project") || "",
    ),
    [snapshot, setSnapshot] = useState(null),
    [docId, setDocId] = useState(() => {
      try {
        const v = JSON.parse(localStorage.getItem("agent-hub-v1-view"));
        return v?.projectId ===
          localStorage.getItem("agent-hub-current-project")
          ? v.docId || ""
          : "";
      } catch {
        return "";
      }
    }),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [modal, setModal] = useState(null),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(""),
    [message, setMessage] = useState(""),
    [target, setTarget] = useState(""),
    [side, setSide] = useState(true),
    [globalRows, setGlobalRows] = useState([]),
    [next, setNext] = useState(null),
    [statusFilter, setStatusFilter] = useState("all");
  const [resultFilters,setResultFilters]=useState({projectId:"",status:"all",from:"",to:""}),[ruleStats,setRuleStats]=useState({}),[ruleNotices,setRuleNotices]=useState([]),[olderMessages,setOlderMessages]=useState([]),[historyDone,setHistoryDone]=useState(false);
  useEffect(() => {
    localStorage.setItem(
      "agent-hub-v1-view",
      JSON.stringify({ projectId, docId }),
    );
  }, [projectId, docId]);
  const [runDetails, setRunDetails] = useState(null),
    [stoppedRun, setStoppedRun] = useState(null),
    [lastSync, setLastSync] = useState(null),
    [offline, setOffline] = useState(false);
  const cursor = useRef("-1:"),
    projectMeta=useRef(null),extraProjects=useRef(new Map()),extraProjectCursor=useRef(null),lastWorkspaceSync=useRef(0),searchRef=useRef(query),pageRef=useRef(page),
    currentProject = useRef(projectId),
    scroll = useRef(null);
  currentProject.current = projectId;
  searchRef.current=query;pageRef.current=page;
  const notify = useCallback((t) => setToast(t), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(t);
  }, [toast]);
  const refreshWorkspace = useCallback(async () => {
    const [w, p] = await Promise.all([
      api("/v2/workspace"),
      api("/v2/projects?"+new URLSearchParams({q:pageRef.current==="projects"?searchRef.current:""})),
    ]);
    setWorkspace(w);
    let selected=projectMeta.current;
    if(currentProject.current && !p.items.some(p=>p.id===currentProject.current) && selected?.id!==currentProject.current){
      try{selected=(await api("/v2/project?id="+currentProject.current)).project;projectMeta.current=selected;}catch(e){if(e.status!==404)throw e;selected=null;}
    }
    const list=[...p.items,...extraProjects.current.values()];
    if(selected && !(pageRef.current==="projects"&&searchRef.current) && !list.some(p=>p.id===selected.id))list.push(selected);
    setProjects([...new Map(list.map(p=>[p.id,p])).values()]);
    setProjectCursor(extraProjects.current.size?extraProjectCursor.current:p.nextCursor);lastWorkspaceSync.current=Date.now();
    setOffline(false);
    setError("");
    if (
      (!currentProject.current || (!selected && !p.items.some(p=>p.id===currentProject.current))) &&
      p.items.some((p) => !p.hidden)
    )
      setProjectId(p.items.find((p) => !p.hidden).id);
  }, []);
  const refreshProject = useCallback(async (id = currentProject.current) => {
    if (!id) return;
    const snap = await api("/v2/project?id=" + id);
    const decisions = await records("decision", { projectId: id });
    if (currentProject.current !== id) return;
    projectMeta.current=snap.project;
    setSnapshot({ ...snap, decisions: decisions.items });
    cursor.current = snap.activityCursor;
    setLastSync(new Date().toISOString());
    const recent = snap.activeRuns[0] || snap.runs[0];
    if (recent) {
      const details = await api("/v2/run?id=" + recent.id);
      if (currentProject.current === id) setRunDetails(details);
    } else setRunDetails(null);
  }, []);
  useEffect(() => {
    refreshWorkspace().catch((e) => {
      setError(e.message);
      setOffline(true);
    });
  }, [refreshWorkspace]);
  useEffect(() => {
    setSnapshot(null);
    setOlderMessages([]);
    setHistoryDone(false);
    setMessage(localStorage.getItem("agent-hub-composer-" + projectId) || "");
    if (projectId) {
      localStorage.setItem("agent-hub-current-project", projectId);
      refreshProject(projectId).catch((e) => setError(e.message));
    }
  }, [projectId, refreshProject]);
  useEffect(() => {
    const t = setInterval(async () => {
      if (document.hidden) return;
      try {
        if (currentProject.current) {
          const r = await api(
            "/v2/activity?projectId=" +
              currentProject.current +
              "&cursor=" +
              encodeURIComponent(cursor.current),
          );
          if (r.events?.length) await refreshProject();
        }
        if (page === "members" || !workspace || Date.now()-lastWorkspaceSync.current>15000) await refreshWorkspace();
        setOffline(false);
      } catch (e) {
        setOffline(true);
      }
    }, 3000);
    return () => clearInterval(t);
  }, [page, workspace, refreshProject, refreshWorkspace]);
  useEffect(()=>{extraProjects.current.clear();extraProjectCursor.current=null;if(page!=="projects"||!workspace)return;const t=setTimeout(()=>refreshWorkspace().catch(e=>setError(e.message)),200);return()=>clearTimeout(t)},[page,query]);
  useEffect(() => {
    if (page === "projects" || !workspace) return;
    if (page === "results") return;
    const kind = {
      results: "document",
      decisions: "decision",
      knowledge: "knowledge",
    }[page];
    if (kind)
      records(kind)
        .then((r) => {
          setGlobalRows(r.items);
          setNext(r.nextCursor);
        })
        .catch((e) => setError(e.message));
  }, [page, workspace]);
  useEffect(()=>{
    if(page!=="results" || !workspace)return;
    let active=true;
    const timer=setTimeout(()=>api("/v2/results?"+new URLSearchParams({...resultFilters,q:query,offset:String(-new Date().getTimezoneOffset())})).then(r=>{if(active){setGlobalRows(r.items);setNext(r.nextCursor)}}).catch(e=>{if(active)setError(e.message)}),200);
    return()=>{active=false;clearTimeout(timer)};
  },[page,workspace,query,resultFilters]);
  useEffect(()=>{if(page!=="knowledge")return;Promise.all([api("/v2/rule-usage"),records("rule_notice",{status:"pending"})]).then(([u,n])=>{setRuleStats(u.usage);setRuleNotices(n.items)}).catch(e=>setError(e.message));},[page,workspace]);
  async function run(fn, success) {
    setBusy(true);
    setError("");
    try {
      const result = await fn();
      if (success) notify(success);
      await refreshWorkspace();
      await refreshProject();
      return result;
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  const members = workspace?.members || [],
    project = snapshot?.project;
  const name = (id) => memberName(members, id);
  const nativeReady = (id) => {const m=workspace?.members.find(m=>m.id===id);return !!m&&!m.paused&&workspace?.connections.find(c=>c.id===id)?.status==="verified";};
  async function send() {
    if (!message.trim()) return;
    try {
      await run(
        () =>
          command("message.send", {
            projectId,
            body: message,
            ...(target ? { memberId: target } : {}),
          }),
        "任务已交给团队",
      );
      setMessage("");
      localStorage.removeItem("agent-hub-composer-" + projectId);
    } catch {}
  }
  function navigate(p) {
    setPage(p);
    setGlobalRows([]);
    setNext(null);
    setDocId("");
    setQuery("");
    setStatusFilter("all");
  }
  async function openDoc(d, pid = projectId) {
    if (pid !== projectId) {
      setProjectId(pid);
      await refreshProject(pid);
    }
    setDocId(d);
    setPage("projects");
  }
  const visibleProjects = projects.filter((p) =>
    (p.name + p.topic).toLowerCase().includes(query.toLowerCase()),
  );
  const deliverables = (snapshot?.documents || []).filter((d) => d.deliverable);
  const pending = (snapshot?.decisions || []).filter(
    (d) => d.status === "pending",
  ).length;
  const controls =
    runDetails?.steps.filter((s) => s.status === "needs_review") || [];
  const actualPhase = project?.status==="paused" ? "项目已暂停，原平台执行可能继续" : !runDetails ? "尚未开始" : ["completed","partially_met"].includes(runDetails.run.status) ? `${label(runDetails.run.status)}${pending?` · ${pending}项待你决定`:""}` : runDetails.steps.some(s=>["integrate","resolve"].includes(s.phase)&&["running","ready"].includes(s.status)) ? "正在汇总成果" : runDetails.steps.some(s=>s.phase==="verify"&&["running","ready"].includes(s.status)) ? "正在核对冲突依据" : runDetails.steps.filter(s=>s.phase==="explore").map(s=>`${name(s.memberId)} ${s.status==="completed"?"已交付":label(s.status)}`).join(" · ") || label(runDetails.run.status);
  return (
    <div className="hub" data-build-id={BUILD.id}>
      <div className="app-body">
        <nav className="rail" aria-label="主导航">
          <div className="logo">
            <Layers size={25} />
          </div>
          {[
            [MessageSquare, "projects", "项目"],
            [FileText, "results", "成果"],
            [Inbox, "decisions", "待我决定"],
            [BookOpen, "knowledge", "知识库"],
            [Users, "members", "成员"],
          ].map(([Icon, id, title]) => (
            <Button
              variant="ghost"
              className={page === id ? "active" : ""}
              key={id}
              onClick={() => navigate(id)}
              aria-label={title}
            >
              <Icon size={22} strokeWidth={1.6} />
              {title}
            </Button>
          ))}
          <Button
            variant="ghost"
            className={"rail-bottom " + (page === "settings" ? "active" : "")}
            onClick={() => navigate("settings")}
          >
            <Settings size={22} />
            设置
          </Button>
          <Avatar className="size-8 mt-2">
            <AvatarFallback>D</AvatarFallback>
          </Avatar>
        </nav>
        {page === "projects" && (
          <aside className="list-pane">
            <div className="list-heading">
              <h1>项目</h1>
              <Button
                size="icon"
                variant="ghost"
                aria-label="新建项目"
                onClick={() => setModal({ type: "create" })}
              >
                <Plus size={18} />
              </Button>
            </div>
            <Input
              className="project-search"
              style={{ width: "calc(100% - 28px)" }}
              aria-label="搜索项目"
              placeholder="搜索项目"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="project-items">
              <small className="block px-2 py-2">
                我的工作空间 · 已载入 {projects.length}{projectCursor?"+":""}
              </small>
              {visibleProjects.map((p) => (
                <div
                  className={
                    "project-item " + (projectId === p.id ? "current" : "")
                  }
                  key={p.id}
                >
                  <button
                    onClick={() => {
                      setProjectId(p.id);
                      setDocId("");
                    }}
                  >
                    <Folder className="mt-1 shrink-0" size={17} />
                    <span>
                      <strong>{p.name}{workspace?.pendingByProject?.[p.id]>0&&<i className="status-dot ml-2 inline-block bg-amber-500" title="有待确认事项" aria-label="有待确认事项"/>}</strong>
                      <small>{p.topic?.slice(0, 36)}</small>
                    </span>
                  </button>
                  {projectId === p.id && deliverables.length > 0 && (
                    <button
                      className="review-link"
                      onClick={() => setDocId(deliverables[0].id)}
                    >
                      审阅成果 <ArrowRight size={13} />
                    </button>
                  )}
                </div>
              ))}
              {projectCursor&&<Button variant="ghost" className="w-full" disabled={busy} onClick={async()=>{setBusy(true);try{const r=await api("/v2/projects?"+new URLSearchParams({q:query,cursor:projectCursor}));for(const p of r.items)extraProjects.current.set(p.id,p);extraProjectCursor.current=r.nextCursor;setProjectCursor(r.nextCursor);setProjects(old=>[...new Map([...old,...r.items].map(p=>[p.id,p])).values()]);}catch(e){setError(e.message)}finally{setBusy(false)}}}>加载更多项目</Button>}
            </div>
            <button
              className="list-foot text-left"
              onClick={() => navigate("knowledge")}
            >
              <BookOpen size={16} className="inline mr-2" />
              资料与规则
              <small className="block mt-1">
                {snapshot?.knowledge.filter((k) => k.status === "pending")
                  .length || 0}{" "}
                条待确认
              </small>
            </button>
          </aside>
        )}
        <main className="main">
          {error && (
            <div className="alert-bar" role="alert">
              <AlertCircle size={16} />
              <span className="flex-1">{error}</span>
              <Button size="sm" variant="ghost" onClick={() => setError("")}>
                知道了
              </Button>
            </div>
          )}
          {offline && (
            <div className="status-line text-amber-700">
              连接中断，保留当前内容；恢复后继续同步。
              <Button
                size="sm"
                variant="link"
                onClick={() =>
                  refreshWorkspace()
                    .then(() => refreshProject())
                    .catch((e) => setError(e.message))
                }
              >
                重新连接
              </Button>
            </div>
          )}
          {!workspace ? (
            <div className="p-10 space-y-5">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-40 w-3/4" />
            </div>
          ) : page === "projects" ? (
            docId && snapshot ? (
              <React.Suspense
                fallback={
                  <div className="empty">
                    <Skeleton className="w-64 h-8" />
                    正在打开成果…
                  </div>
                }
              >
                <Document
                  key={docId}
                  documentId={docId}
                  project={snapshot}
                  members={members}
                  onBack={() => setDocId("")}
                  onChange={() => refreshProject().catch(() => {})}
                  notify={notify}
                  onRule={(rule,notice)=>setModal({type:"rule",rule,notice})}
                />
              </React.Suspense>
            ) : !project ? (
              <Empty
                title="从一个目标开始"
                body="把已有的 Agent 接到这里，一次交代目标，收回可以继续编辑和使用的成果。"
              >
                <div className="flex gap-3">
                  <Button onClick={() => setModal({ type: "create" })}>
                    <Plus size={16} />
                    新建项目
                  </Button>
                  <Button variant="outline" onClick={() => navigate("members")}>
                    连接成员
                  </Button>
                </div>
              </Empty>
            ) : (
              <>
                <header className="project-head">
                  <Folder size={19} className="text-primary" />
                  <h2>{project.name}</h2>
                  <span className="mode">
                    {actualPhase}
                  </span>
                  <div className="head-actions">
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => navigate("decisions")}
                    >
                      {pending} 项待决定
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setModal({ type: "plan", project })}
                    >
                      <SlidersHorizontal size={15} />
                      工作安排
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="查看运行记录"
                      onClick={() => setModal({ type: "run" })}
                    >
                      <Clock size={17} />
                    </Button>
                    <Button variant="outline" size="sm" disabled={busy} onClick={()=>run(()=>command("project.control",{projectId,control:project.status==="active"?"pause":"resume"})).catch(()=>{})}>{project.status==="active"?"暂停项目":"恢复项目"}</Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="展开成果与资料"
                      onClick={() => setSide(!side)}
                    >
                      <PanelRight size={17} />
                    </Button>
                  </div>
                </header>
                {project.planSuggestion && (
                  <div className="status-line">
                    团队返回了一份安排建议，当前安排没有改变。
                    <Button
                      size="sm"
                      variant="link"
                      onClick={() => setModal({ type: "plan", project })}
                    >
                      查看建议
                    </Button>
                  </div>
                )}
                {project.zeroContributionStreak >=
                  (project.nextContributionReminder || 3) && (
                  <div className="failure-strip">
                    最近 3 轮协作没有记录到额外贡献，要不要改为一位完成？
                    <div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          run(() =>
                            command("project.update", {
                              projectId,
                              revision: project.revision,
                              arrangement: {
                                ...project.arrangement,
                                mode: "solo",
                                members: [project.arrangement.lead],
                                delivery: "final",
                              },
                            }),
                          ).catch(() => {})
                        }
                      >
                        改为一位完成
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          run(() =>
                            command("project.keep_mode", { projectId }),
                          ).catch(() => {})
                        }
                      >
                        保持现状
                      </Button>
                    </div>
                  </div>
                )}
                {(snapshot.memberSuggestions||[]).map(s=><div className="status-line" key={s.id}><span>{name(s.suggestedBy)} 建议加 {name(s.memberId)}：{s.reason} · 确认后下一轮生效</span><Button size="sm" disabled={!nativeReady(s.memberId)||busy} onClick={()=>run(()=>command("member.suggestion.review",{suggestionId:s.id,action:"accept"})).catch(()=>{})}>同意</Button><Button size="sm" variant="ghost" onClick={()=>run(()=>command("member.suggestion.review",{suggestionId:s.id,action:"reject"})).catch(()=>{})}>不用</Button>{!nativeReady(s.memberId)&&<small>此成员尚不可接任务，请先处理接入。</small>}</div>)}
                {controls.length > 0 && (
                  <div className="failure-strip">
                    <strong>
                      本轮需要处理 · 收到{" "}
                      {
                        runDetails.steps.filter((s) => s.status === "completed")
                          .length
                      }
                      /{runDetails.steps.length} 份阶段交付
                    </strong>
                    <p>
                      {controls[0].issues?.join("；") ||
                        "成员尚未返回可确认的交付"}
                    </p>
                    {(controls.some(s => s.activeAttemptId) || runDetails.notifications?.some(n => ["accepted", "unknown", "needs_review"].includes(n.status))) && <label className="flex items-center gap-2 mb-3"><Checkbox checked={stoppedRun === runDetails.run.id} onCheckedChange={v => setStoppedRun(v ? runDetails.run.id : null)}/>已核对原平台，缺失任务已停止</label>}
                    <div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          run(() =>
                            command("step.retry", {
                              stepId: controls[0].id,
                              reason: "重试缺失的成员交付",
                              confirmRemoteStopped: stoppedRun === runDetails.run.id,
                            }),
                          ).catch(() => {})
                        }
                      >
                        只重试缺失成员
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          run(() =>
                            command("run.accept_partial", {
                              runId: runDetails.run.id,
                              confirmRemoteStopped: stoppedRun === runDetails.run.id,
                            }),
                          ).catch(() => {})
                        }
                      >
                        用已有结果成稿（标明缺口）
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          run(() =>
                            command("run.control", {
                              runId: runDetails.run.id,
                              control: "cancel",
                            }),
                          ).catch(() => {})
                        }
                      >
                        终止本轮
                      </Button>
                    </div>
                  </div>
                )}
                <div className="project-body">
                  <section className="chat">
                    <div className="chat-scroll" ref={scroll}>
                      {!historyDone&&snapshot.messages.length>=100&&<Button variant="ghost" size="sm" onClick={async()=>{try{const first=olderMessages[0]||snapshot.messages[0],r=await records("message",{projectId,cursor:btoa(JSON.stringify({updatedAt:first.updatedAt,id:first.id}))});setOlderMessages([...r.items.reverse(),...olderMessages]);if(!r.nextCursor)setHistoryDone(true);}catch(e){setError(e.message)}}}>加载更早记录</Button>}
                      {snapshot.messages.length === 0 ? (
                        <Empty
                          title="团队已经准备好"
                          body="在下方说这次要拿到什么，后续任务沿用本项目安排。"
                        />
                      ) : (
                        [...olderMessages,...snapshot.messages].filter((m,i,all)=>all.findIndex(x=>x.id===m.id)===i).filter(m => snapshot.runs.find(r => r.id === m.runId)?.purpose !== "learn").map((m) =>
                          m.type === "handoff" ? (
                            <details className="handoff-line" key={m.id}>
                              <summary className="cursor-pointer">
                                {name(m.memberId)} · {m.body} ·{" "}
                                <span className="text-primary">查看</span>
                              </summary>
                              <small>
                                运行 {m.runId?.slice(-8)} ·{" "}
                                {time(m.createdAt || m.updatedAt)}
                              </small>
                            </details>
                          ) : m.author === "system" ? (
                            <div className="message system" key={m.id}>
                              <span>{m.body}</span>
                              <small className="ml-3">
                                {time(m.createdAt || m.updatedAt)}
                              </small>
                            </div>
                          ) : (
                            <div className="message" key={m.id}>
                              <Face
                                member={members.find(
                                  (x) =>
                                    x.id === m.memberId || x.id === m.author,
                                )}
                              />
                              <div className="message-content">
                                <div className="message-meta">
                                  <strong>
                                    {m.author === "owner"
                                      ? "我"
                                      : name(m.memberId || m.author)}
                                  </strong>
                                  <time>
                                    {time(m.createdAt || m.updatedAt)}
                                  </time>
                                </div>
                                <div className="message-text">{m.body}</div>
                                {m.documentIds?.map((id) => {
                                  const d = snapshot.documents.find(
                                    (d) => d.id === id,
                                  );
                                  return (
                                    d?.deliverable && (
                                      <button
                                        className="result-link mt-3"
                                        key={id}
                                        onClick={() => setDocId(id)}
                                      >
                                        <FileText
                                          size={20}
                                          className="text-primary"
                                        />
                                        <span>
                                          <strong>{d.title}</strong>
                                          <small>
                                            {label(d.status)} · 审阅成果
                                          </small>
                                        </span>
                                        <ArrowRight
                                          size={15}
                                          className="ml-auto"
                                        />
                                      </button>
                                    )
                                  );
                                })}
                              </div>
                            </div>
                          ),
                        )
                      )}
                    </div>
                    <div className="composer">
                      <div className="composer-box">
                        <Textarea
                          aria-label="项目消息"
                          placeholder="说下这次想做成什么，或继续补充要求…"
                          value={message}
                          onChange={(e) => {
                            setMessage(e.target.value);
                            localStorage.setItem(
                              "agent-hub-composer-" + projectId,
                              e.target.value,
                            );
                          }}
                          onKeyDown={(e) => {
                            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                              e.preventDefault();
                              send();
                            }
                          }}
                        />
                        <div className="composer-tools">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setModal({ type: "reference" })}
                          >
                            <Plus size={14} />
                            引用成果
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label="添加资料"
                            onClick={() => setModal({ type: "material" })}
                          >
                            <Paperclip size={16} />
                          </Button>
                          <select
                            className="text-xs text-muted-foreground bg-transparent max-w-28"
                            aria-label="指定成员"
                            value={target}
                            onChange={(e) => setTarget(e.target.value)}
                          >
                            <option value="">团队安排</option>
                            {project.arrangement?.members.map((id) => (
                              <option key={id} value={id}>
                                {name(id)}
                              </option>
                            ))}
                          </select>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground"
                            onClick={() => setModal({ type: "plan", project })}
                          >
                            调整安排
                          </Button>
                          <Button
                            className="send"
                            size="icon"
                            aria-label="发送消息"
                            disabled={busy || !message.trim()}
                            onClick={send}
                          >
                            <ArrowUp size={18} />
                          </Button>
                        </div>
                      </div>
                      <small className="block mt-2">
                        {runDetails ? label(runDetails.run.status) : "尚未开始"}{" "}
                        · 最近同步 {time(lastSync)}
                      </small>
                    </div>
                  </section>
                  {side && (
                    <aside className="side-pane">
                      <Tabs defaultValue="results">
                        <TabsList className="w-full">
                          <TabsTrigger value="results">
                            成果 {deliverables.length}
                          </TabsTrigger>
                          <TabsTrigger value="materials">资料</TabsTrigger>
                          <TabsTrigger value="members">成员</TabsTrigger>
                          <TabsTrigger value="evidence">依据</TabsTrigger>
                        </TabsList>
                        <TabsContent value="results" className="pt-4">
                          {project.arrangement?.delivery === "compare" &&
                            deliverables.length >= 2 && (
                              <Button
                                className="w-full mb-4"
                                variant="outline"
                                onClick={() => setModal({ type: "comparison" })}
                              >
                                并排审阅独立成果
                              </Button>
                            )}
                          {deliverables.map((d) => (
                            <button
                              className="result-link"
                              key={d.id}
                              onClick={() => setDocId(d.id)}
                            >
                              <FileText
                                className="text-primary mt-1"
                                size={18}
                              />
                              <span>
                                <strong>{d.title}</strong>
                                <small>
                                  {name(d.memberId)} · {label(d.status)}
                                </small>
                              </span>
                            </button>
                          ))}
                          {project.comparisonDraftId && (
                            <Button
                              className="w-full mb-4"
                              variant="outline"
                              onClick={() =>
                                setDocId(project.comparisonDraftId)
                              }
                            >
                              我的工作稿
                            </Button>
                          )}
                          {!deliverables.length && (
                            <p className="text-muted-foreground leading-7 text-sm">
                              成员完成后，成果出现在这里；研究过程和内部修订留在运行记录中。
                            </p>
                          )}
                        </TabsContent>
                        <TabsContent value="materials" className="pt-4">
                          {project.materials?.map((m, i) => (
                            <div className="source-row" key={i}>
                              <strong>{m.title}</strong>
                              <p>{m.body}</p>
                              {m.fileId && (
                                <a href={"/api/v2/files/" + m.fileId} download>
                                  {m.fileName || "下载原始附件"} ↗
                                </a>
                              )}
                              {m.url && (
                                <a
                                  target="_blank"
                                  rel="noreferrer"
                                  href={m.url}
                                >
                                  原始资料 ↗
                                </a>
                              )}
                            </div>
                          ))}
                          <Button
                            variant="outline"
                            className="mt-4 w-full"
                            onClick={() => setModal({ type: "material" })}
                          >
                            <Plus size={15} />
                            添加资料
                          </Button>
                        </TabsContent>
                        <TabsContent value="members" className="pt-4">
                          {project.arrangement?.members.map((id) => (
                            <div
                              className="flex gap-3 items-center py-4"
                              key={id}
                            >
                              <Face member={members.find((m) => m.id === id)} />
                              <div>
                                <strong>{name(id)}</strong>
                                <small className="block">
                                  {nativeReady(id) ? "可接任务" : "待验证"}
                                </small>
                              </div>
                            </div>
                          ))}
                          <PairingFacts project={project} members={members}/>
                        </TabsContent>
                        <TabsContent value="evidence" className="pt-4">
                          {deliverables.map(d=><div className="source-row" key={d.id}><strong>{d.title}</strong><p>独有发现 {d.record?.unique||0} · 独立互证 {d.record?.independent||0} · 有据纠错 {d.record?.corrections||0}</p>{d.sourceEvidence?.claims?.filter(c=>c.important||c.risk).map(c=><p key={c.id}>{c.text}</p>)}<Button size="sm" variant="link" onClick={()=>setDocId(d.id)}>查看完整依据</Button></div>)}
                          {!deliverables.length&&<p>成果交回后，论断、来源和核查依据会出现在这里。</p>}
                        </TabsContent>
                      </Tabs>
                    </aside>
                  )}
                </div>
              </>
            )
          ) : page === "members" ? (
            <div className="page">
              <div className="page-title">
                <div>
                  <h1>成员</h1>
                  <p>连接你已有的 Agent，保留各自的模型、工具和账号能力。</p>
                </div>
                <Button onClick={() => setModal({ type: "member" })}>
                  <Plus size={16} />
                  添加成员
                </Button>
              </div>
              <div className="member-grid">
                {members.map((m) => {
                  const c = workspace.connections.find((c) => c.id === m.id);
                  return (
                    <article className="member-card" key={m.id}>
                      <div className="member-card-top">
                        <Face member={m} />
                        <div>
                          <h2>{m.name}</h2>
                          <small>
                            {m.platformId === "grok-bot"
                              ? "Grok Bot · X 实时讨论"
                              : m.platformId === "chatgpt-agent"
                                ? "Dot · ChatGPT 应用、邮箱"
                                : "第二批接入"}
                          </small>
                        </div>
                      </div>
                      <State status={m.paused ? "paused" : c?.status || "未连接"} />
                      <small>唤醒方式：{m.platformId==="grok-bot"||m.platformId==="chatgpt-agent"?"主动叫醒":"定时检查"}</small>
                      <p>
                        {c?.verifiedAt
                          ? "最近一次真实任务成功：" + time(c.verifiedAt)
                          : "授权、工具连通、通知与实际回复分别核验。配置本身不代表可接任务。"}
                      </p>
                      {["grok-bot", "chatgpt-agent"].includes(m.platformId) ? (
                        <Button
                          variant="outline"
                          onClick={() =>
                            setModal({ type: "connect", member: m })
                          }
                        >
                          {c?.status === "verified" ? "查看连接" : "连接与验证"}
                          <ArrowRight size={14} />
                        </Button>
                      ) : (
                        <Button disabled variant="outline">
                          第二批开放
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        className="ml-2"
                        onClick={() => setModal({ type: "rename", member: m })}
                      >
                        修改备注
                      </Button>
                    </article>
                  );
                })}
              </div>
              <PairingFacts all members={members}/>
              <p className="scope-note">
                Agent Hub 只能约束经过 Hub
                的操作；成员在自己平台上的工具和权限不受影响。现有浏览器资料不因升级、改名或连接配置而重建。
              </p>
            </div>
          ) : page === "results" ? (
            <div className="page">
              <div className="page-title">
                <div>
                  <h1>成果</h1>
                  <p>把每一次交付留下来，找到、改好，再用于下一次。</p>
                </div>
              </div>
              <Input
                placeholder="搜索成果"
                aria-label="搜索成果"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="max-w-sm mb-6"
              />
              <ResultFilters projects={projects} value={resultFilters} onChange={setResultFilters}/>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>成果名称</TableHead>
                    <TableHead>项目 / 成员</TableHead>
                    <TableHead>更新</TableHead>
                    <TableHead>版本数</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>继续使用</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {globalRows
                    .filter(
                      (d) =>
                        d.deliverable,
                    )
                    .map((d) => (
                      <TableRow key={d.id}>
                        <TableCell>
                          <button
                            className="font-semibold text-left"
                            onClick={() => {
                              setProjectId(d.scopeId);
                              setDocId(d.id);
                              setPage("projects");
                            }}
                          >
                            {d.title}
                          </button>
                        </TableCell>
                        <TableCell>
                          {projects.find((p) => p.id === d.scopeId)?.name}
                          <small className="block">{name(d.memberId)}</small>
                        </TableCell>
                        <TableCell>{time(d.updatedAt)}</TableCell>
                        <TableCell>{d.versionCount || 1}</TableCell>
                        <TableCell>
                          <State
                            status={
                              d.evaluatedVersionId === d.workingVersionId
                                ? d.feedback
                                : d.status
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="link"
                            onClick={() =>
                              setModal({
                                type: "create",
                                reference: {
                                  title: d.title,
                                  sourceDocument: d.id,
                                  version: d.workingVersionId,
                                },
                              })
                            }
                          >
                            用于新任务
                            <ArrowRight size={14} />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
              {next && (
                <Button
                  variant="outline"
                  className="mt-5"
                  onClick={async () => {
                    const r = await api("/v2/results?"+new URLSearchParams({...resultFilters,q:query,offset:String(-new Date().getTimezoneOffset()),cursor:next}));
                    setGlobalRows([...globalRows, ...r.items]);
                    setNext(r.nextCursor);
                  }}
                >
                  加载更早成果
                </Button>
              )}
              {!globalRows.some((d) => d.deliverable) && (
                <Empty
                    title={query||resultFilters.projectId||resultFilters.from||resultFilters.to||resultFilters.status!=="all"?"没有符合筛选的成果":"还没有最终成果"}
                    body="可调整筛选或清空搜索；团队的最终交付保存在这里，过程材料仍留在项目中。"
                />
              )}
            </div>
          ) : page === "decisions" ? (
            <div className="page">
              <div className="page-title">
                <div>
                  <h1>待我决定</h1>
                  <p>真正需要你取舍的事，回到正文里处理。</p>
                </div>
              </div>
              <Tabs
                value={statusFilter === "done" ? "done" : "pending"}
                onValueChange={(v) =>
                  setStatusFilter(v === "done" ? "done" : "all")
                }
              >
                <TabsList>
                  <TabsTrigger value="pending">待处理</TabsTrigger>
                  <TabsTrigger value="done">已处理</TabsTrigger>
                </TabsList>
              </Tabs>
              {globalRows
                .filter((d) =>
                  statusFilter === "done"
                    ? d.status !== "pending"
                    : d.status === "pending",
                )
                .map((d) => (
                  <div className="rule-row" key={d.id}>
                    <div className="row-top">
                      <Badge variant="outline">
                        {projects.find((p) => p.id === d.scopeId)?.name}
                      </Badge>
                      <strong>{d.title}</strong>
                    </div>
                    <p>{d.description}</p>
                    {d.status!=="pending"&&<p>你的选择：{d.choice} · {time(d.chosenAt)}{d.ruleId&&" · 已关联长期规则"}</p>}
                    <Button
                      variant="outline"
                      onClick={() => {
                        setProjectId(d.scopeId);
                        setDocId(d.documentId);
                        setPage("projects");
                      }}
                    >
                      在稿件中{d.status === "pending" ? "处理" : "查看"}
                      <ArrowRight size={15} />
                    </Button>
                  </div>
                ))}
              {!globalRows.some((d) => d.status === "pending") &&
                statusFilter !== "done" && (
                  <Empty
                    title="暂时没有需要你决定的事"
                    body="普通交接继续推进，重要取舍才出现在这里。规则确认在知识库里处理。"
                  />
                )}
            </div>
          ) : page === "knowledge" ? (
            <div className="page">
              <div className="page-title">
                <div>
                  <h1>知识库</h1>
                  <p>把确认过的规则与资料带到下一次，不把建议当成事实。</p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => setModal({ type: "rule" })}
                >
                  <Plus size={15} />
                  添加规则
                </Button>
              </div>
              <Tabs defaultValue="rules">
                <TabsList>
                  <TabsTrigger value="rules">规则</TabsTrigger>
                  <TabsTrigger value="materials">资料</TabsTrigger>
                </TabsList>
                <TabsContent value="rules">
                  {ruleNotices.map(n=><RuleNotice key={n.id} notice={n} rule={globalRows.find(k=>k.id===n.ruleId)} busy={busy} onAction={run} onEdit={(rule,notice)=>setModal({type:"rule",rule,notice})}/>)}
                  {globalRows
                    .filter((k) => k.category !== "material")
                    .sort(
                      (a, b) =>
                        (a.status === "pending" ? -1 : 1) -
                        (b.status === "pending" ? -1 : 1),
                    )
                    .map((k) => (
                      <div className="rule-row" key={k.id}>
                        <div className="row-top">
                          <strong>{k.title}</strong>
                          <Badge variant="secondary">
                            {(k.scopeMode || (k.scopeId === "global" ? "global" : "project")) === "global"
                              ? "全部项目"
                              : k.scopeMode === "type" ? `同类 · ${k.projectType}`
                              : projects.find((p) => p.id === (k.appliesToProjectId || k.scopeId))
                                  ?.name || "本项目"}
                          </Badge>
                          <State status={k.status} />
                        </div>
                        <p>{k.body}</p>
                        {k.status==="pending"&&<RuleScope value={k.scopeMode || "project"} project={projects.find(p=>p.id===(k.appliesToProjectId||k.scopeId))} onChange={scopeMode=>setGlobalRows(rows=>rows.map(r=>r.id===k.id?{...r,scopeMode}:r))}/>}
                        <small>
                          来源：
                          {k.source === "decision" ? "来自你的决定" : k.source === "human_edit"
                            ? "来自你的改稿"
                            : k.author === "owner"
                              ? "手动添加"
                              : "成员提议"}{" "}
                          · {time(k.createdAt)}
                        </small>
                        <small className="block">已用于 {ruleStats[k.id]?.rounds || 0} 轮 · {ruleStats[k.id]?.latest?.status==="followed"?"结果已符合（有段落回执）":ruleStats[k.id]?.latest?.status==="deviated"?"发现偏离":"结果未确认"}{ruleStats[k.id]?.latest?.paragraph&&` · ${ruleStats[k.id].latest.paragraph}`}</small>
                        <div className="row-actions">
                          {k.status === "pending" ? (
                            <>
                              <Button
                                size="sm"
                                onClick={() =>
                                  run(() =>
                                    command("knowledge.review", {
                                      knowledgeId: k.id,
                                      revision: k.revision,
                                      status: "approved",
                                      scopeMode: k.scopeMode || "project",
                                    }),
                                  ).catch(() => {})
                                }
                              >
                                以后都这样
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  run(() =>
                                    command("knowledge.review", {
                                      knowledgeId: k.id,
                                      revision: k.revision,
                                      status: "rejected",
                                    }),
                                  ).catch(() => {})
                                }
                              >
                                只这次
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  run(() =>
                                    command("knowledge.review", {
                                      knowledgeId: k.id,
                                      revision: k.revision,
                                      status: "trial",
                                    }),
                                  ).catch(() => {})
                                }
                              >
                                先试一轮
                              </Button>
                            </>
                          ) : k.status === "approved" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                run(() =>
                                  command("knowledge.review", {
                                    knowledgeId: k.id,
                                    revision: k.revision,
                                    status: "revoked",
                                  }),
                                ).catch(() => {})
                              }
                            >
                              撤回
                            </Button>
                          ) : ["trial", "trial_used"].includes(k.status) ? (
                            <>
                              <Button
                                size="sm"
                                onClick={() =>
                                  run(() =>
                                    command("knowledge.review", {
                                      knowledgeId: k.id,
                                      revision: k.revision,
                                      status: "approved",
                                    }),
                                  ).catch(() => {})
                                }
                              >
                                保留为长期规则
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  run(() =>
                                    command("knowledge.review", {
                                      knowledgeId: k.id,
                                      revision: k.revision,
                                      status: "revoked",
                                    }),
                                  ).catch(() => {})
                                }
                              >
                                撤回
                              </Button>
                            </>
                          ) : null}
                          <Button
                            variant="link"
                            size="sm"
                            onClick={() => setModal({ type: "rule", rule: k })}
                          >
                            修订
                          </Button>
                        </div>
                      </div>
                    ))}
                </TabsContent>
                <TabsContent value="materials">
                  <Button
                    variant="outline"
                    onClick={() =>
                      setModal({ type: "material", library: true })
                    }
                  >
                    <Plus size={15} />
                    添加资料
                  </Button>
                  {globalRows
                    .filter((k) => k.category === "material")
                    .map((k) => (
                      <div className="source-row" key={k.id}>
                        <strong>{k.title}</strong>
                        <p>{k.body}</p>
                        {k.fileIds?.map((id) => (
                          <a
                            className="block"
                            key={id}
                            href={"/api/v2/files/" + id}
                            download
                          >
                            下载原始附件 ↗
                          </a>
                        ))}
                        <small>
                          来源时间：{k.sourcePublishedAt || "未提供"} ·
                          采集时间：{time(k.createdAt)}
                        </small>
                      </div>
                    ))}
                </TabsContent>
              </Tabs>
              <p className="scope-note">
                “本轮已带入”只证明派发携带了对应规则版本；“结果已符合”需要程序检查或审阅成员给出具体段落。
              </p>
            </div>
          ) : (
            <div className="page">
              <div className="page-title">
                <div>
                  <h1>运行设置</h1>
                  <p>本地工作台，连接用户已有的 Agent。</p>
                </div>
              </div>
              <div className="max-w-xl space-y-5">
                <Alert>
                  <AlertTitle>连接方式</AlertTitle>
                  <AlertDescription>
                    Grok 使用原生 MCP 与 Routine，Dot 使用 MCP Events。Hub
                    不调用额外大模型，不修改你的 VPN 和日常浏览器。
                  </AlertDescription>
                </Alert>
                <Button
                  variant="outline"
                  onClick={() =>
                    run(
                      () => api("/v2/maintenance", {}),
                      "已检查调度状态",
                    ).catch(() => {})
                  }
                >
                  <RefreshCw size={15} />
                  检查后台调度
                </Button>
                <Button
                  variant="outline"
                  className="ml-3"
                  onClick={() => window.location.assign("/?legacy=1")}
                >
                  旧版设置与资料
                </Button>
              </div>
            </div>
          )}
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
      <Dialog open={!!modal} onOpenChange={(v) => !v && setModal(null)}>
        <DialogContent className="max-h-[88vh] overflow-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {
                {
                  create: "从一个目标开始",
                  plan: "工作安排",
                  member: "添加成员",
                  rename: "修改备注",
                  connect: "连接你的 Agent",
                  run: "本轮运行记录",
                  reference: "引用已有成果",
                  material: "添加项目资料",
                  rule: modal?.rule ? "修订规则" : "添加规则",
                  comparison: "独立成果，并排看看",
                }[modal?.type]
              }
            </DialogTitle>
            <DialogDescription>
              {modal?.type === "connect"
                ? "只有实际往返完成才显示可接任务。"
                : "所有改动按项目和版本保留。"}
            </DialogDescription>
          </DialogHeader>
          {["create", "plan"].includes(modal?.type) && (
            <ProjectWizard
              project={
                modal.type === "plan"
                  ? { ...project, schedule: snapshot.schedule }
                  : undefined
              }
              reference={modal.reference}
              members={members}
              connections={workspace.connections}
              onClose={() => setModal(null)}
              onSave={async (config) => {
                await run(async () => {
                  let p;
                  if (modal.type === "plan") {
                    p = await command("project.update", {
                      projectId,
                      revision: project.revision,
                      goal: config.goal,
                      arrangement: config.arrangement,
                      projectType: config.projectType,
                    });
                    if (config.times.length || snapshot.schedule)
                      await command("schedule.set", {
                        projectId,
                        times: config.times,
                        timeZone: config.timeZone,
                        enabled: config.times.length > 0,
                      });
                  } else {
                    p = await command("project.create", config);
                    setDocId("");
                    setProjectId(p.id);
                    if (config.times.length)
                      await command("schedule.set", {
                        projectId: p.id,
                        times: config.times,
                        timeZone: config.timeZone,
                        enabled: true,
                      });
                    await command("run.start", { projectId: p.id });
                  }
                  setModal(null);
                  setPage("projects");
                  return p;
                });
              }}
            />
          )}
          {modal?.type === "connect" && (
            <ConnectWizard
              member={modal.member}
              connection={workspace.connections.find(
                (c) => c.id === modal.member.id,
              )}
              refresh={refreshWorkspace}
              notify={notify}
              onError={setError}
            />
          )}
          {["member", "rename"].includes(modal?.type) && (
            <MemberForm
              member={modal.member}
              onSave={async (p) => {
                await run(async () => {
                  if (modal.type === "rename")
                    return api("/action", {
                      type: "member.update",
                      memberId: modal.member.id,
                      payload: { name: p.name },
                    });
                  let account = workspace.accounts.find(
                    (a) => a.platformId === p.platformId && a.name === p.name,
                  );
                  if (!account)
                    account = (
                      await api("/action", {
                        type: "account.create",
                        payload: { platformId: p.platformId, label: p.name },
                      })
                    ).result;
                  return api("/action", {
                    type: "member.create",
                    payload: {
                      accountId: account.id,
                      name: p.name,
                      mode: "connector",
                    },
                  });
                }, "成员已保留，等待真实连接");
                setModal(null);
              }}
            />
          )}
          {modal?.type === "run" && (
            <div className="space-y-4">
              <RunHistory projectId={projectId} members={members}/>

            </div>
          )}
          {modal?.type === "reference" && (
            <ReferencePicker
              onPick={async (d) => {
                await run(
                  () =>
                    command("project.material", {
                      projectId,
                      material: {
                        title: d.title,
                        sourceDocument: d.id,
                        version: d.workingVersionId,
                      },
                    }),
                  "已引用指定版本",
                );
                setModal(null);
              }}
            />
          )}
          {modal?.type === "material" && (
            <MaterialForm
              projectId={projectId}
              library={modal.library}
              projects={projects}
              onSave={async (m) => {
                await run(async () => {
                  const scope = m.projectId || projectId;
                  let file;
                  if (m.file) file = await upload(m.file, scope);
                  const material = {
                    title: m.title,
                    body: m.body,
                    url: m.url,
                    sourcePublishedAt:m.sourcePublishedAt||null,
                    ...(file
                      ? {
                          fileId: file.id,
                          fileName: file.name,
                          sha256: file.sha256,
                        }
                      : {}),
                  };
                  if (modal.library)
                    return command("knowledge.write", {
                      projectId: scope,
                      title: m.title,
                      body: m.body || m.url || file?.name,
                      category: "material",
                      approved: true,
                      fileIds: file ? [file.id] : [],
                      sourcePublishedAt:m.sourcePublishedAt||null,
                    });
                  return command("project.material", {
                    projectId: scope,
                    material,
                  });
                }, "资料已添加");
                setModal(null);
              }}
            />
          )}
          {modal?.type === "rule" && (
            <RuleForm
              rule={modal.rule}
              projectId={modal.notice?.scopeId || projectId}
              projects={projects}
              onSave={async (p) => {
                await run(
                  async () => {
                    const item=await command("knowledge.write", {
                      ...p,
                      ...(modal.rule
                        ? {
                            knowledgeId: modal.rule.id,
                            revision: modal.rule.revision,
                          }
                        : {}),
                    });
                    if(modal.notice)await command("rule.notice.resolve",{noticeId:modal.notice.id,action:"edited"});
                    return item;
                  },
                  "规则已保留",
                );
                setModal(null);
              }}
            />
          )}
          {modal?.type === "comparison" && (
            <Comparison
              project={snapshot}
              members={members}
              onAdopt={async (id, index) => {
                const d = await run(
                  () =>
                    command("comparison.adopt", {
                      projectId,
                      sourceDocumentId: id,
                      sectionIndex: index,
                    }),
                  "原文已加入工作稿",
                );
                setModal(null);
                setDocId(d.id);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
function ProjectWizard({
  project,
  reference,
  members,
  connections,
  onClose,
  onSave,
}) {
  const [step, setStep] = useState(1),
    [goal, setGoal] = useState(project?.topic || ""),
    [kind,setKind]=useState(project?.projectType || ""),
    [a, setA] = useState(
      project?.arrangement || {
        mode: "parallel",
        delivery: "final",
        members: members
          .filter((m) =>
            !m.paused && connections.some((c) => c.id === m.id && c.status === "verified"),
          )
          .slice(0, 2)
          .map((m) => m.id),
        lead: "",
        criteria: ["每条结论附来源", "缺少的信息写明缺口"],
        internalRevisions: 1,
      },
    ),
    [times, setTimes] = useState(
      project?.schedule?.status === "enabled"
        ? (
            project.schedule.times || [
              `${String(project.schedule.hour).padStart(2, "0")}:${String(project.schedule.minute).padStart(2, "0")}`,
            ]
          ).join("、")
        : "",
    ),
    [zone, setZone] = useState(project?.schedule?.timeZone || "Asia/Shanghai"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [link, setLink] = useState(""),
    [adviceRun, setAdviceRun] = useState(null),
    [advice, setAdvice] = useState(project?.planSuggestion || null),
    [materials, setMaterials] = useState(
      reference ? [reference] : project?.materials || [],
    );
  useEffect(() => {
    if (!adviceRun || advice) return;
    const t = setInterval(
      () =>
        api("/v2/run?id=" + adviceRun)
          .then((r) => {
            if (r.run.planSuggestion) {
              setAdvice(r.run.planSuggestion);
            }
          })
          .catch((e) => setError(e.message)),
      3000,
    );
    return () => clearInterval(t);
  }, [adviceRun, advice]);
  const chosen = members.filter((m) => a.members.includes(m.id)),
    lead = chosen.find((m) => m.id === a.lead) || chosen.at(-1);
  const patch = (v) => setA({ ...a, ...v });
  async function next() {
    setError("");
    if (step === 1) {
      if (!goal.trim()) return setError("先写下目标");
      if (!project) {
        const mode = /研究|调研|找|对比|评估/.test(goal)
          ? "parallel"
          : /方案|计划|决定|评审/.test(goal)
            ? "review"
            : "solo";
        patch({
          mode,
          criteria: [
            ...new Set([
              ...a.criteria,
              ...goal.split(/[。；\n]/).filter((s) => /必须|需要|要/.test(s)),
            ]),
          ],
        });
      }
      setStep(2);
      return;
    }
    if (step === 2) {
      if (
        !chosen.length ||
        ((a.delivery === "compare" || a.mode !== "solo") && chosen.length < 2)
      )
        return setError("所选方式至少需要两位已验证成员；请先在成员页接入。");
      if (!a.criteria.some((c) => c.trim()))
        return setError("请至少保留一条合格标准");
      setStep(3);
      return;
    }
    setBusy(true);
    try {
      await onSave({
        adviceRunId: adviceRun,
        name: project?.name || goal.slice(0, 24),
        goal,
        projectType: kind,
        materials,
        arrangement: {
          ...a,
          members:
            a.mode === "solo" && a.delivery === "final"
              ? [lead?.id || a.members[0]]
              : a.members,
          lead: lead?.id,
          criteria: a.criteria.filter((c) => c.trim()),
        },
        times: times.split(/[、,，\s]+/).filter(Boolean),
        timeZone: zone,
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="wizard-stepper">
        {["说目标", "工作安排", "定节奏"].map((s, i) => (
          <span key={s} className={step === i + 1 ? "current" : ""}>
            {i + 1} {s}
          </span>
        ))}
      </div>
      <div className="wizard-section">
        {step === 1 ? (
          <>
            <label>
              你想让团队做成什么？
              <Textarea
                aria-label="项目目标"
                rows={5}
                placeholder="例如：研究智能戒指有没有适合个人开发者的机会"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
              />
            </label>
            <label className="grid gap-2">项目类型（可选）<Input aria-label="项目类型" maxLength={40} placeholder="例如：内容创作、旅行研究" value={kind} onChange={e=>setKind(e.target.value)}/><small>同类型项目可共享你确认的规则。留空只按本项目使用，不自动猜类型。</small></label>
            <div className="flex gap-2">
              <Input
                placeholder="添加资料链接"
                value={link}
                onChange={(e) => setLink(e.target.value)}
              />
              <Button
                variant="outline"
                disabled={!/^https?:\/\//.test(link)}
                onClick={() => {
                  setMaterials([...materials, { title: link, url: link }]);
                  setLink("");
                }}
              >
                添加资料
              </Button>
            </div>
            {materials.map((m, i) => (
              <small key={i}>{m.title}</small>
            ))}
          </>
        ) : step === 2 ? (
          <>
            <p className="text-muted-foreground leading-7">{goal}</p>
            <label>交付形式</label>
            <div className="choice-grid">
              {[
                ["final", "一份最终结果"],
                ["compare", "各自提交，并排对比"],
              ].map(([id, t]) => (
                <button
                  className={"choice " + (a.delivery === id ? "selected" : "")}
                  key={id}
                  onClick={() => patch({ delivery: id })}
                >
                  <i className="radio" />
                  {t}
                </button>
              ))}
            </div>
            <div className="connect-box !my-0 !py-3">
              {a.delivery === "compare"
                ? chosen.map((m) => m.name).join("、") + " 各一份，并排显示"
                : `一份由 ${lead?.name || "所选成员"} 汇总的成果`}
            </div>
            {a.delivery === "final" && (
              <>
                <label>怎么做</label>
                <div className="space-y-2">
                  {COLLAB_MODES.map((m) => (
                    <button
                      className={
                        "choice w-full " + (a.mode === m.id ? "selected" : "")
                      }
                      key={m.id}
                      onClick={() => patch({ mode: m.id })}
                    >
                      <i className="radio" />
                      {m.label}
                    </button>
                  ))}
                </div>
              </>
            )}
            <small>按目标类型给出的默认安排，可以修改。</small>
            <label>参与成员</label>
            <div className="flex gap-3 flex-wrap">
              {members
                .filter((m) =>
                  ["grok-bot", "chatgpt-agent"].includes(m.platformId),
                )
                .map((m) => (
                  <label
                    className="!flex items-center gap-2 rounded-lg border px-3 py-3"
                    key={m.id}
                  >
                    <Checkbox
                      checked={a.members.includes(m.id)}
                      disabled={
                        m.paused || !connections.some(
                          (c) => c.id === m.id && c.status === "verified",
                        )
                      }
                      onCheckedChange={(v) =>
                        patch({
                          members: v
                            ? [...a.members, m.id]
                            : a.members.filter((id) => id !== m.id),
                        })
                      }
                    />
                    {m.name}
                    <small>
                      {m.platformId === "grok-bot"
                        ? "X 实时讨论"
                        : "ChatGPT 应用、邮箱"}
                    </small>
                  </label>
                ))}
            </div>
            {a.mode !== "solo" && a.delivery === "final" && (
              <label>
                汇总 / 检查成员
                <select
                  className="border rounded-md px-3 py-2"
                  value={lead?.id || ""}
                  onChange={(e) => patch({ lead: e.target.value })}
                >
                  {chosen.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <small>信源标签只是平台能力提示；是否已接入具体应用、邮箱及账号权限，以成员实际返回为准，未知时不会视为可用。</small>
            <PairingFacts project={{...project,projectType:kind,arrangement:a}} members={members}/>
            <label className="flex gap-2 items-center"><Checkbox checked={!!a.important} onCheckedChange={v=>patch({important:!!v})}/>这项工作很重要</label>
            {a.important && a.mode==="solo" && <div className="scope-note">你标了重要，可以加一位检查。{members.find(m=>!m.paused&&!a.members.includes(m.id)&&connections.some(c=>c.id===m.id&&c.status==="verified")) && <Button variant="link" onClick={()=>{const checker=members.find(m=>!m.paused&&!a.members.includes(m.id)&&connections.some(c=>c.id===m.id&&c.status==="verified"));patch({mode:"review",members:[a.members[0],checker.id],lead:checker.id});}}>加一位检查</Button>}</div>}
            <div>
              <label>合格标准</label>
              {a.criteria.map((c, i) => (
                <div className="criterion-row" key={i}>
                  <Input
                    aria-label={"合格标准 " + (i + 1)}
                    value={c}
                    onChange={(e) =>
                      patch({
                        criteria: a.criteria.map((s, n) =>
                          n === i ? e.target.value : s,
                        ),
                      })
                    }
                  />
                  <Button
                    variant="ghost"
                    onClick={() =>
                      patch({ criteria: a.criteria.filter((_, n) => n !== i) })
                    }
                  >
                    删除
                  </Button>
                </div>
              ))}
              <Button
                variant="link"
                onClick={() => patch({ criteria: [...a.criteria, ""] })}
              >
                <Plus size={14} />
                添加标准
              </Button>
            </div>
            <Button
              variant="outline"
              onClick={async () => {
                setError("");
                try {
                  const r = await command("arrangement.suggest", {
                    projectId: project?.id,
                    goal,
                    members: a.members,
                    lead: lead?.id,
                  });
                  setAdviceRun(r.id);
                  setError(
                    "安排建议已发出，当前安排不变。返回后可选择是否采用。",
                  );
                } catch (e) {
                  setError(e.message);
                }
              }}
            >
              让团队安排
            </Button>
            <small>
              额外叫醒 {lead?.name || "已选成员"} 一次，费用以原平台为准。
            </small>
            {advice && (
              <div className="connect-box">
                <strong>成员建议</strong>
                <p>
                  {COLLAB_MODES.find((m) => m.id === advice.mode)?.label} ·{" "}
                  {advice.criteria.join("；")}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setA(advice);
                    setAdvice(null);
                  }}
                >
                  应用建议
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setAdvice(null)}
                >
                  保留当前安排
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            <label>执行节奏</label>
            <div className="choice-grid">
              <button
                className={"choice " + (!times ? "selected" : "")}
                onClick={() => setTimes("")}
              >
                <i className="radio" />
                只做一次
              </button>
              <button
                className={"choice " + (times ? "selected" : "")}
                onClick={() => setTimes(times || "06:00、12:00、19:00")}
              >
                <i className="radio" />
                定期做
              </button>
            </div>
            {times && (
              <>
                <label>
                  时间点
                  <Input
                    aria-label="运行时间"
                    value={times}
                    onChange={(e) => setTimes(e.target.value)}
                  />
                </label>
                <label>
                  时区
                  <Input
                    aria-label="运行时区"
                    value={zone}
                    onChange={(e) => setZone(e.target.value)}
                  />
                </label>
              </>
            )}
            <small>
              {project
                ? "正在执行时，新安排从下一轮生效。"
                : "开始后由后台调度，任务与成果都会保留。"}
            </small>
          </>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
      <div className="wizard-footer">
        <Button
          variant="ghost"
          onClick={() => (step === 1 ? onClose() : setStep(step - 1))}
        >
          {step === 1 ? "取消" : "上一步"}
        </Button>
        <Button disabled={busy} onClick={next}>
          {step === 3 ? (project ? "保存安排" : "开始") : "下一步"}
          <ArrowRight size={15} />
        </Button>
      </div>
    </>
  );
}
function ConnectWizard({ member, connection, refresh, notify, onError }) {
  const grok = member.platformId === "grok-bot",
    steps = grok
      ? ["命名", "连接", "接收任务", "测试"]
      : ["命名", "连接", "测试"];
  const [step, setStep] = useState(0),
    [pair, setPair] = useState(null),
    [url, setUrl] = useState(""),
    [token, setToken] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const final = step === steps.length - 1;
  const probePending = ["running", "ready"].includes(connection?.probe?.status);
  async function call(fn) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e.message);
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="connection-steps">
        {steps.map((s, i) => (
          <span className={step === i ? "current" : ""} key={s}>
            {i + 1} {s}
          </span>
        ))}
      </div>
      {error && <Alert variant="destructive"><AlertCircle size={16}/><AlertTitle>未完成</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {step === 0 ? (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold">{member.name}</h3>
          <p className="text-muted-foreground leading-7">
            备注不改变原账号和登录资料。同类平台可以添加多个独立成员。
          </p>
        </div>
      ) : final ? (
        <div className="space-y-5">
          <h3 className="font-semibold">验证真实往返</h3>
          {[
            ["已授权", !!(connection?.authorizedAt || connection?.authSeenAt)],
            ["工具可调用", !!connection?.toolSeenAt],
            ...(!grok
              ? [["任务通知已开启", !!connection?.subscriptionActive]]
              : []),
            [
              "已送达",
              !!connection?.lastDeliveryAt || !!connection?.deliveryEvidence,
            ],
            ["已回复", connection?.status === "verified"],
          ].map(([text, ok]) => (
            <div className="flex gap-3 items-center" key={text}>
              <Check
                size={17}
                className={ok ? "text-emerald-600" : "text-slate-300"}
              />
              {text}
            </div>
          ))}
          <Button
            disabled={busy || probePending || connection?.status === "verified"}
            onClick={() =>
              call(() => command("connection.probe", { memberId: member.id }))
            }
          >
            {probePending ? "等待原 Agent 回传" : connection?.probe?.status === "needs_review" ? "重新发送测试" : "发送测试"}
          </Button>
          <small className="block leading-6">
            通知送达只是受理。Dot
            事件可能延迟到达；没有实际回复，不会显示可接任务。
          </small>
        </div>
      ) : step === 1 ? (
        <>
          <p className="leading-7">
            添加 Agent Hub 的私有 MCP，原 Agent 仍使用自己的模型与工具。
          </p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              call(async () =>
                setPair(await api("/v2/pairing", { memberId: member.id })),
              )
            }
          >
            生成一次性配对
          </Button>
          {pair && (
            <>
              <div className="connect-box">
                {pair.instructions}
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-3"
                  onClick={() => {
                    navigator.clipboard.writeText(pair.instructions);
                    notify("已复制接入说明（不含配对码）");
                  }}
                >
                  <Copy size={14} />
                  复制说明
                </Button>
              </div>
              <small>
                只在授权页输入，勿发到聊天；15 分钟有效、仅能使用一次。
              </small>
              <div className="pair-code">{pair.code}</div>
            </>
          )}
          {(connection?.authorizedAt || connection?.authSeenAt) && (
            <Badge className="bg-emerald-50 text-emerald-700">
              平台授权已确认，工具调用会单独测试
            </Badge>
          )}
          {grok && (
            <small className="block mt-4">
              Grok 插件对你的整个账号有效，其他 Bot 也能使用。
            </small>
          )}
        </>
      ) : (
        <div className="space-y-5">
          <p className="leading-7">
            请让原 Grok Bot 创建只由 webhook 触发的自动化或
            Routine，收到门铃后调用 Hub 工具领取任务。
          </p>
          <Button
            variant="outline"
            onClick={() => {
              navigator.clipboard.writeText(
                "请创建只由 webhook 触发的自动化或 Routine：收到通知后调用 Agent Hub 的 list_work、claim_work，按领取上下文执行，最后 submit_work；通知本身只带编号，不把通知送达当作完成。",
              );
              notify("已复制 Routine 说明");
            }}
          >
            复制给 Grok 的说明
          </Button>
          <label className="grid gap-2">
            Webhook URL
            <Input
              aria-label="Routine Webhook URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="原平台提供的 HTTPS 地址"
            />
          </label>
          <label className="grid gap-2">
            Webhook 密钥
            <Input
              aria-label="Webhook 密钥"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <Button
            variant="outline"
            disabled={!url || !token || busy}
            onClick={() =>
              call(async () => {
                if (new URL(url).pathname.startsWith("/webhook/automation/") && !/^whsec_[A-Za-z0-9+/]{32,88}={0,2}$/.test(token)) {
                  throw new Error("请复制 Grok 提供的完整签名密钥，不能使用省略显示的预览或其他剪贴板内容");
                }
                await api("/v2/connections", {
                  requestId: crypto.randomUUID(),
                  memberId: member.id,
                  platform: "grok-bot",
                  url,
                  token,
                });
                setToken("");
                notify("已加密保存接收任务配置，仍需真实测试");
              })
            }
          >
            保存接收配置
          </Button>
        </div>
      )}
      <div className="wizard-footer">
        <Button
          variant="ghost"
          disabled={step === 0}
          onClick={() => setStep(step - 1)}
        >
          上一步
        </Button>
        {!final && (
          <Button
            disabled={
              busy ||
              (step === 1 &&
                !(connection?.authorizedAt || connection?.authSeenAt)) ||
              (grok &&
                step === 2 &&
                !["configured", "verified"].includes(connection?.status))
            }
            onClick={() => setStep(step + 1)}
          >
            下一步
            <ArrowRight size={14} />
          </Button>
        )}
        {final && <State status={connection?.status || "未连接"} />}
      </div>
    </>
  );
}
function MemberForm({ member, onSave }) {
  const [name, setName] = useState(member?.name || ""),
    [platform, setPlatform] = useState(member?.platformId || "grok-bot"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="space-y-5">
      {!member && (
        <label className="grid gap-2">
          平台
          <select
            className="border rounded-md px-3 py-2"
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
          >
            <option value="grok-bot">Grok Bot</option>
            <option value="chatgpt-agent">Dot</option>
          </select>
        </label>
      )}
      <label className="grid gap-2">
        备注名称
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：我的 Grok"
        />
      </label>
      {error && <p className="state-red">{error}</p>}
      <Button
        disabled={!name.trim() || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onSave({ name: name.trim(), platformId: platform });
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        保存
      </Button>
    </div>
  );
}
function ReferencePicker({ onPick }) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    records("document").then((r) =>
      setRows(r.items.filter((d) => d.deliverable)),
    );
  }, []);
  return (
    <div className="space-y-2">
      {rows.map((d) => (
        <Button
          variant="outline"
          className="w-full justify-start"
          key={d.id}
          onClick={() => onPick(d)}
        >
          <FileText size={16} />
          {d.title}
          <small className="ml-auto">引用指定版本</small>
        </Button>
      ))}
      {!rows.length && <p>还没有可引用的成果。</p>}
    </div>
  );
}
function MaterialForm({ onSave, projectId, library, projects = [] }) {
  const [title, setTitle] = useState(""),
    [sourcePublishedAt,setSourcePublishedAt]=useState(""),
    [body, setBody] = useState(""),
    [url, setUrl] = useState(""),
    [file, setFile] = useState(null),
    [scope, setScope] = useState(projectId || projects[0]?.id || "global"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="space-y-5">
      {library && (
        <label className="grid gap-2">
          资料范围
          <select
            className="border rounded-md px-3 py-2"
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              setFile(null);
            }}
          >
            <option value="global">全局（文字或链接）</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <Input
        aria-label="资料标题"
        placeholder="资料标题"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <Input
        aria-label="原始链接"
        placeholder="原始链接（可选）"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <Textarea
        aria-label="资料内容"
        placeholder="资料内容"
        rows={6}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <label className="grid gap-2">来源发布时间（可选）<Input type="date" aria-label="来源发布时间" value={sourcePublishedAt} onChange={e=>setSourcePublishedAt(e.target.value)}/></label>
      {scope !== "global" && (
        <label className="grid gap-2">
          原始附件（最多 8 MB）
          <Input
            type="file"
            aria-label="原始附件"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </label>
      )}
      {error && (
        <p className="state-red" role="alert">
          {error}
        </p>
      )}
      <Button
        disabled={busy || !title || (!body && !url && !file)}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await onSave({ title, body, url, file, projectId: scope,sourcePublishedAt });
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "保存中…" : "添加资料"}
      </Button>
    </div>
  );
}
function RuleForm({ rule, projectId, projects, onSave }) {
  const [title, setTitle] = useState(rule?.title || ""),
    [body, setBody] = useState(rule?.body || ""),
    [scope, setScope] = useState(
      rule?.appliesToProjectId || (rule?.scopeId!=="global"?rule?.scopeId:null) || projectId || projects[0]?.id || "global",
    ),[scopeMode,setScopeMode]=useState(rule?.scopeMode || (rule?.scopeId==="global"||!projects.length?"global":"project"));
  return (
    <div className="space-y-5">
      <Input
        placeholder="规则标题"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <Textarea
        placeholder="希望今后怎么做？"
        rows={5}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <select
        className="border rounded-md px-3 py-2"
        value={scope}
        onChange={(e) => setScope(e.target.value)}
      >
        <option value="global">无关联项目</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <RuleScope value={scopeMode} onChange={setScopeMode} project={projects.find(p=>p.id===scope)}/>
      <Button
        disabled={!title || !body}
        onClick={() =>
          onSave({ title, body, projectId: rule?.scopeId || scope, appliesToProjectId:scope==="global"?undefined:scope,scopeMode, approved: true })
        }
      >
        确认保存
      </Button>
    </div>
  );
}
function Comparison({ project, members, onAdopt }) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    Promise.all(
      project.documents
        .filter((d) => d.deliverable)
        .slice(0, 2)
        .map((d) => api("/v2/document?id=" + d.id)),
    ).then(setRows);
  }, [project]);
  return (
    <div className="compare-grid">
      {rows.map((d) => (
        <article key={d.id}>
          <h2>
            {memberName(members, d.memberId)} · {d.title}
          </h2>
          <CheckSummary
            doc={d}
            members={members}
            criteria={project.project.arrangement.criteria}
          />
          {d.working.body
            .split(/\n\s*\n/)
            .filter(Boolean)
            .map((paragraph, i) => (
              <section className="border-b py-4" key={i}>
                <div className="compare-text">{paragraph}</div>
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => onAdopt(d.id, i)}
                >
                  采用这段
                </Button>
              </section>
            ))}
        </article>
      ))}
    </div>
  );
}
